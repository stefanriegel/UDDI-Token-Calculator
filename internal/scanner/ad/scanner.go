// Package ad implements scanner.Scanner for Active Directory via WinRM/NTLM.
// It discovers DNS zones and records, DHCP scopes, leases, and reservations, and AD
// user accounts by executing PowerShell commands on one or more domain controllers
// concurrently. Results are deduplicated across DCs (set-union aggregation).
package ad

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	krbclient "github.com/jcmturner/gokrb5/v8/client"
	krbconfig "github.com/jcmturner/gokrb5/v8/config"
	"github.com/masterzen/winrm"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

const (
	winrmPort        = 5985
	winrmTimeout     = 60 * time.Second
	maxConcurrentDCs = 3
)

// Scanner implements scanner.Scanner for Active Directory using WinRM over NTLM.
type Scanner struct {
	adServerMetricsJSON []byte // set after Scan() completes
}

// New returns a ready-to-use AD Scanner.
func New() *Scanner { return &Scanner{} }

// GetADServerMetricsJSON implements scanner.ADResultScanner.
func (s *Scanner) GetADServerMetricsJSON() []byte { return s.adServerMetricsJSON }

// dcResult holds the per-DC deduplicated resource keys discovered from one DC.
// Each field is a set (map[string]struct{}) so merging across DCs is a trivial
// set-union — replicated objects are naturally deduplicated.
type dcResult struct {
	zoneNames       map[string]struct{}
	recordKeys      map[string]struct{}
	scopeIDs        map[string]struct{}
	leaseKeys       map[string]struct{}
	reservationKeys map[string]struct{}
	userKeys        map[string]struct{}
	computerKeys    map[string]struct{} // Get-ADComputer results
	staticIPKeys    map[string]struct{} // Computers with IPv4Address (static IPs)
	computerName    string

	// Per-DC raw counts (before cross-DC dedup) for ADServerMetric construction.
	dnsObjectCount  int // zones + records on this DC
	dhcpObjectCount int // scopes + leases + reservations on this DC
	qps             int // DNS QPS from event log
	lps             int // DHCP LPS from event log
}

// dcAggregator accumulates dcResult values from multiple DCs under a caller-held mutex.
type dcAggregator struct {
	zoneNames       map[string]struct{}
	recordKeys      map[string]struct{}
	scopeIDs        map[string]struct{}
	leaseKeys       map[string]struct{}
	reservationKeys map[string]struct{}
	userKeys        map[string]struct{}
	computerKeys    map[string]struct{}
	staticIPKeys    map[string]struct{}
	dcNames         []string
	dcResults       []*dcResult // per-DC results for ADServerMetric construction
}

// init allocates all maps. Call before the first merge.
func (a *dcAggregator) init() {
	a.zoneNames = make(map[string]struct{})
	a.recordKeys = make(map[string]struct{})
	a.scopeIDs = make(map[string]struct{})
	a.leaseKeys = make(map[string]struct{})
	a.reservationKeys = make(map[string]struct{})
	a.userKeys = make(map[string]struct{})
	a.computerKeys = make(map[string]struct{})
	a.staticIPKeys = make(map[string]struct{})
}

// merge performs a set-union of r into a. The caller must hold any required mutex.
func (a *dcAggregator) merge(r *dcResult) {
	for k := range r.zoneNames {
		a.zoneNames[k] = struct{}{}
	}
	for k := range r.recordKeys {
		a.recordKeys[k] = struct{}{}
	}
	for k := range r.scopeIDs {
		a.scopeIDs[k] = struct{}{}
	}
	for k := range r.leaseKeys {
		a.leaseKeys[k] = struct{}{}
	}
	for k := range r.reservationKeys {
		a.reservationKeys[k] = struct{}{}
	}
	for k := range r.userKeys {
		a.userKeys[k] = struct{}{}
	}
	for k := range r.computerKeys {
		a.computerKeys[k] = struct{}{}
	}
	for k := range r.staticIPKeys {
		a.staticIPKeys[k] = struct{}{}
	}
	if r.computerName != "" {
		a.dcNames = append(a.dcNames, r.computerName)
	}
	a.dcResults = append(a.dcResults, r)
}

// normalizeZoneName lowercases s, strips surrounding whitespace, and removes a
// trailing dot. This matches the Python reference _collect_dns zone normalization.
func normalizeZoneName(s string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(s), "."))
}

// userKey returns a deduplication key for an AD user using the priority chain:
// sid: > upn: > sam:. Returns an empty string if all three fields are empty;
// callers must skip empty keys.
func userKey(sid, upn, sam string) string {
	switch {
	case sid != "":
		return "sid:" + strings.ToLower(sid)
	case upn != "":
		return "upn:" + strings.ToLower(upn)
	case sam != "":
		return "sam:" + strings.ToLower(sam)
	default:
		return ""
	}
}

// adServerMetricInternal mirrors server.ADServerMetric to avoid an import cycle.
// Marshaled to JSON and stored on the scanner; the server package decodes it.
type adServerMetricInternal struct {
	Hostname              string `json:"hostname"`
	DNSObjects            int    `json:"dnsObjects"`
	DHCPObjects           int    `json:"dhcpObjects"`
	DHCPObjectsWithOverhead int  `json:"dhcpObjectsWithOverhead"`
	QPS                   int    `json:"qps"`
	LPS                   int    `json:"lps"`
	Tier                  string `json:"tier"`
	ServerTokens          int    `json:"serverTokens"`
}

// serverTokenTier is an NIOS-X on-prem tier definition for AD DC sizing.
// Mirrors SERVER_TOKEN_TIERS from nios-calc.ts.
type serverTokenTier struct {
	name         string
	maxQPS       int
	maxLPS       int
	maxObjects   int
	serverTokens int
}

// adServerTiers is the NIOS-X on-prem tier table used for AD DC sizing.
// Values match SERVER_TOKEN_TIERS in frontend/src/app/components/nios-calc.ts.
var adServerTiers = []serverTokenTier{
	{name: "2XS", maxQPS: 5_000, maxLPS: 75, maxObjects: 3_000, serverTokens: 130},
	{name: "XS", maxQPS: 10_000, maxLPS: 150, maxObjects: 7_500, serverTokens: 250},
	{name: "S", maxQPS: 20_000, maxLPS: 200, maxObjects: 29_000, serverTokens: 470},
	{name: "M", maxQPS: 40_000, maxLPS: 300, maxObjects: 110_000, serverTokens: 880},
	{name: "L", maxQPS: 70_000, maxLPS: 400, maxObjects: 440_000, serverTokens: 1_900},
	{name: "XL", maxQPS: 115_000, maxLPS: 675, maxObjects: 880_000, serverTokens: 2_700},
}

// calcADTier finds the smallest NIOS-X on-prem tier that fits all three metrics.
// Uses the DHCP object count (with +20% overhead already applied) as the objectCount input.
func calcADTier(qps, lps, objectCount int) serverTokenTier {
	for _, t := range adServerTiers {
		if qps <= t.maxQPS && lps <= t.maxLPS && objectCount <= t.maxObjects {
			return t
		}
	}
	return adServerTiers[len(adServerTiers)-1] // cap at XL
}

// dhcpWithOverhead applies +20% overhead: ceil(count * 1.2).
func dhcpWithOverhead(count int) int {
	return int(math.Ceil(float64(count) * 1.2))
}

// Scan satisfies scanner.Scanner. It reads req.Credentials["servers"] (comma-separated
// list of DC hostnames), fans out concurrently (up to maxConcurrentDCs), aggregates
// results via dcAggregator, then emits FindingRows and builds per-DC ADServerMetrics.
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	serversStr := req.Credentials["servers"]
	var hosts []string
	for _, h := range strings.Split(serversStr, ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return nil, fmt.Errorf("ad: at least one server hostname is required")
	}

	username := req.Credentials["username"]
	password := req.Credentials["password"]

	// Parse eventLogWindowHours (default 72 = 3 days).
	eventLogWindowHours := 72
	if v, err := strconv.Atoi(req.Credentials["eventLogWindowHours"]); err == nil && v > 0 {
		eventLogWindowHours = v
	}

	var clientOpts []ClientOption
	if req.Credentials["use_ssl"] == "true" {
		clientOpts = append(clientOpts, WithHTTPS())
	}
	if req.Credentials["insecure_skip_verify"] == "true" {
		clientOpts = append(clientOpts, WithInsecureSkipVerify())
	}

	agg := scanAllDCs(ctx, hosts, username, password, eventLogWindowHours, publish, clientOpts...)

	// If no DC connected at all, return a top-level error so the orchestrator
	// records a ProviderError that is surfaced in the results API.
	if len(agg.dcNames) == 0 {
		return nil, fmt.Errorf("ad: failed to connect to any server (%s)", strings.Join(hosts, ", "))
	}

	// source uses resolved DC computer names so the Detailed Findings table shows
	// meaningful names (DC01, DC02) instead of raw IPs. Falls back to user-entered
	// host if COMPUTERNAME query failed for that DC.
	source := strings.Join(agg.dcNames, ", ")

	// Emit final resource_progress events from aggregated counts.
	zoneCount := len(agg.zoneNames)
	recordCount := len(agg.recordKeys)
	scopeCount := len(agg.scopeIDs)
	leaseCount := len(agg.leaseKeys)
	reservationCount := len(agg.reservationKeys)
	userCount := len(agg.userKeys)
	computerCount := len(agg.computerKeys)
	staticIPCount := len(agg.staticIPKeys)

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAD,
		Resource: "dns_zone",
		Count:    zoneCount,
		Status:   "done",
	})
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAD,
		Resource: "dns_record",
		Count:    recordCount,
		Status:   "done",
	})
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAD,
		Resource: "dhcp_scope",
		Count:    scopeCount,
		Status:   "done",
	})
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAD,
		Resource: "dhcp_lease",
		Count:    leaseCount,
		Status:   "done",
	})
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAD,
		Resource: "dhcp_reservation",
		Count:    reservationCount,
		Status:   "done",
	})
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAD,
		Resource: "user_account",
		Count:    userCount,
		Status:   "done",
	})

	// Build per-DC ADServerMetric from per-DC raw counts.
	var adMetrics []adServerMetricInternal
	for _, dc := range agg.dcResults {
		dhcpOverhead := dhcpWithOverhead(dc.dhcpObjectCount)
		totalObjects := dc.dnsObjectCount + dhcpOverhead
		tier := calcADTier(dc.qps, dc.lps, totalObjects)
		adMetrics = append(adMetrics, adServerMetricInternal{
			Hostname:              dc.computerName,
			DNSObjects:            dc.dnsObjectCount,
			DHCPObjects:           dc.dhcpObjectCount,
			DHCPObjectsWithOverhead: dhcpOverhead,
			QPS:                   dc.qps,
			LPS:                   dc.lps,
			Tier:                  tier.name,
			ServerTokens:          tier.serverTokens,
		})
	}

	// Marshal and store on scanner for retrieval via GetADServerMetricsJSON().
	if len(adMetrics) > 0 {
		if encoded, err := json.Marshal(adMetrics); err == nil {
			s.adServerMetricsJSON = encoded
		}
	}

	allRows := []calculator.FindingRow{
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_zone",
			Count:            zoneCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(zoneCount, calculator.TokensPerDDIObject),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_record",
			Count:            recordCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(recordCount, calculator.TokensPerDDIObject),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dhcp_scope",
			Count:            scopeCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(scopeCount, calculator.TokensPerDDIObject),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryActiveIPs,
			Item:             "dhcp_lease",
			Count:            leaseCount,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: ceilDiv(leaseCount, calculator.TokensPerActiveIP),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryActiveIPs,
			Item:             "dhcp_reservation",
			Count:            reservationCount,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: ceilDiv(reservationCount, calculator.TokensPerActiveIP),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryManagedAssets,
			Item:             "user_account",
			Count:            userCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: ceilDiv(userCount, calculator.TokensPerManagedAsset),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryManagedAssets,
			Item:             "computer_count",
			Count:            computerCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: ceilDiv(computerCount, calculator.TokensPerManagedAsset),
		},
		{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         calculator.CategoryActiveIPs,
			Item:             "static_ip_count",
			Count:            staticIPCount,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: ceilDiv(staticIPCount, calculator.TokensPerActiveIP),
		},
	}

	// Filter out zero-count rows so empty results don't clutter the table.
	var findings []calculator.FindingRow
	for _, row := range allRows {
		if row.Count > 0 {
			findings = append(findings, row)
		}
	}
	if len(findings) == 0 {
		return findings, fmt.Errorf("ad: no resources discovered on %s (DNS, DHCP, and AD User queries all returned empty results)", source)
	}
	return findings, nil
}

// scanAllDCs fans out to all DCs concurrently (up to maxConcurrentDCs), merges
// results via dcAggregator, and returns the aggregated totals.
func scanAllDCs(ctx context.Context, hosts []string, username, password string, eventLogWindowHours int, publish func(scanner.Event), opts ...ClientOption) *dcAggregator {
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		agg dcAggregator
		sem = make(chan struct{}, maxConcurrentDCs)
	)
	agg.init()

	for _, host := range hosts {
		host := host
		wg.Add(1)

		publish(scanner.Event{
			Type:     "progress",
			Provider: scanner.ProviderAD,
			Status:   "progress",
			Message:  "Scanning " + host + "...",
		})

		go func() {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			if ctx.Err() != nil {
				return
			}

			result := scanOneDC(ctx, host, username, password, eventLogWindowHours, publish, opts...)
			if result == nil {
				return
			}

			mu.Lock()
			agg.merge(result)
			mu.Unlock()
		}()
	}

	wg.Wait()
	return &agg
}

// scanOneDC connects to a single DC and collects DNS, DHCP, user, computer, and event log data.
// Returns nil on connection failure (error is published as an event). Per-resource
// errors are isolated: a DNS failure does not prevent DHCP or user collection.
func scanOneDC(ctx context.Context, host, username, password string, eventLogWindowHours int, publish func(scanner.Event), opts ...ClientOption) *dcResult {
	client, err := BuildNTLMClient(host, username, password, opts...)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAD,
			Status:   "error",
			Message:  fmt.Sprintf("%s: WinRM client error: %s", host, err.Error()),
		})
		return nil
	}

	computerName, cnErr := runPS(ctx, client, `$env:COMPUTERNAME`)
	if cnErr != nil || strings.TrimSpace(computerName) == "" {
		computerName = host
	}

	result := &dcResult{
		zoneNames:       make(map[string]struct{}),
		recordKeys:      make(map[string]struct{}),
		scopeIDs:        make(map[string]struct{}),
		leaseKeys:       make(map[string]struct{}),
		reservationKeys: make(map[string]struct{}),
		userKeys:        make(map[string]struct{}),
		computerKeys:    make(map[string]struct{}),
		staticIPKeys:    make(map[string]struct{}),
	}
	result.computerName = computerName

	// DNS — error isolated
	dnsResult, err := collectDNS(ctx, client)
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dns_zone",
			Count:    0,
			Status:   "error",
			Message:  fmt.Sprintf("%s: %s", host, err.Error()),
		})
		// zoneNames and recordKeys stay empty for this DC
	} else {
		result.zoneNames = dnsResult.zoneNames
		result.recordKeys = dnsResult.recordKeys
	}

	// DHCP — error isolated
	dhcpResult, err := collectDHCP(ctx, client)
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dhcp_scope",
			Count:    0,
			Status:   "error",
			Message:  fmt.Sprintf("%s: %s", host, err.Error()),
		})
		// scopeIDs, leaseKeys, reservationKeys stay empty for this DC
	} else {
		result.scopeIDs = dhcpResult.scopeIDs
		result.leaseKeys = dhcpResult.leaseKeys
		result.reservationKeys = dhcpResult.reservationKeys
	}

	// Users — error isolated
	userResult, err := collectUsers(ctx, client)
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "user_account",
			Count:    0,
			Status:   "error",
			Message:  fmt.Sprintf("%s: %s", host, err.Error()),
		})
		// userKeys stays empty for this DC
	} else {
		result.userKeys = userResult.userKeys
	}

	// Computers — error isolated
	compResult, err := collectComputers(ctx, client)
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "computer_count",
			Count:    0,
			Status:   "error",
			Message:  fmt.Sprintf("%s: %s", host, err.Error()),
		})
	} else {
		result.computerKeys = compResult.computerKeys
		result.staticIPKeys = compResult.staticIPKeys
	}

	// Per-DC raw counts for ADServerMetric construction.
	result.dnsObjectCount = len(result.zoneNames) + len(result.recordKeys)
	result.dhcpObjectCount = len(result.scopeIDs) + len(result.leaseKeys) + len(result.reservationKeys)

	// Event log QPS — graceful fallback to 0
	result.qps, _ = collectEventLogQPS(ctx, client, eventLogWindowHours)

	// Event log LPS — graceful fallback to 0
	result.lps, _ = collectEventLogLPS(ctx, client, eventLogWindowHours)

	return result
}

// collectDNS runs Get-DnsServerZone and Get-DnsServerResourceRecord and
// returns a *dcResult with zoneNames and recordKeys populated.
func collectDNS(ctx context.Context, client *winrm.Client) (*dcResult, error) {
	const zoneScript = `Get-DnsServerZone -ErrorAction Stop | ` +
		`Select-Object @{Name='ZoneName';Expression={$_.ZoneName}} | ` +
		`ConvertTo-Json -Compress`

	zonePayload, err := runPSJSON(ctx, client, zoneScript)
	if err != nil {
		return nil, fmt.Errorf("dns zones: %w", err)
	}

	result := &dcResult{
		zoneNames:  make(map[string]struct{}),
		recordKeys: make(map[string]struct{}),
	}

	zoneObjects := toObjectList(zonePayload)
	for _, zone := range zoneObjects {
		zoneName, _ := zone["ZoneName"].(string)
		if zoneName == "" {
			continue
		}
		normalizedZone := normalizeZoneName(zoneName)
		result.zoneNames[normalizedZone] = struct{}{}

		escaped := psQuote(zoneName)
		recordScript := fmt.Sprintf(
			`Get-DnsServerResourceRecord -ZoneName '%s' -ErrorAction Stop | `+
				`Select-Object `+
				`@{Name='HostName';Expression={($_.HostName).ToString()}},`+
				`@{Name='RecordType';Expression={($_.RecordType).ToString()}},`+
				`@{Name='RecordData';Expression={($_.RecordData | ConvertTo-Json -Compress -Depth 6)}} | `+
				`ConvertTo-Json -Compress`,
			escaped,
		)

		recPayload, recErr := runPSJSON(ctx, client, recordScript)
		if recErr != nil {
			// Skip zones that fail (e.g. reverse zones with restricted access).
			continue
		}

		for _, rec := range toObjectList(recPayload) {
			owner := strings.ToLower(strings.TrimSpace(str(rec["HostName"])))
			recordType := str(rec["RecordType"])
			recordDataStr := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", rec["RecordData"])))
			recordKey := fmt.Sprintf("%s|%s|%s|%s", normalizedZone, owner, recordType, recordDataStr)
			result.recordKeys[recordKey] = struct{}{}
		}
	}

	return result, nil
}

// collectDHCP runs Get-DhcpServerv4Scope, Get-DhcpServerv4Lease, and
// Get-DhcpServerv4Reservation and returns a *dcResult with scopeIDs,
// leaseKeys, and reservationKeys populated.
func collectDHCP(ctx context.Context, client *winrm.Client) (*dcResult, error) {
	const scopeScript = `Get-DhcpServerv4Scope -ErrorAction Stop | ` +
		`Select-Object @{Name='ScopeId';Expression={$_.ScopeId.IPAddressToString}} | ` +
		`ConvertTo-Json -Compress`

	scopePayload, err := runPSJSON(ctx, client, scopeScript)
	if err != nil {
		return nil, fmt.Errorf("dhcp scopes: %w", err)
	}

	result := &dcResult{
		scopeIDs:        make(map[string]struct{}),
		leaseKeys:       make(map[string]struct{}),
		reservationKeys: make(map[string]struct{}),
	}

	for _, scope := range toObjectList(scopePayload) {
		scopeID, _ := scope["ScopeId"].(string)
		if scopeID == "" {
			continue
		}
		normalizedScope := strings.ToLower(scopeID)
		result.scopeIDs[normalizedScope] = struct{}{}

		escaped := psQuote(scopeID)

		// Collect leases for this scope.
		leaseScript := fmt.Sprintf(
			`Get-DhcpServerv4Lease -ScopeId '%s' -ErrorAction Stop | `+
				`Select-Object @{Name='IPAddress';Expression={$_.IPAddress.IPAddressToString}} | `+
				`ConvertTo-Json -Compress`,
			escaped,
		)
		leasePayload, leaseErr := runPSJSON(ctx, client, leaseScript)
		if leaseErr == nil {
			for _, lease := range toObjectList(leasePayload) {
				ip, _ := lease["IPAddress"].(string)
				if ip == "" {
					continue
				}
				leaseKey := fmt.Sprintf("%s|%s", normalizedScope, strings.ToLower(ip))
				result.leaseKeys[leaseKey] = struct{}{}
			}
		}

		// Collect reservations for this scope.
		reservationScript := fmt.Sprintf(
			`Get-DhcpServerv4Reservation -ScopeId '%s' -ErrorAction Stop | `+
				`Select-Object @{Name='IPAddress';Expression={$_.IPAddress.IPAddressToString}} | `+
				`ConvertTo-Json -Compress`,
			escaped,
		)
		resPayload, resErr := runPSJSON(ctx, client, reservationScript)
		if resErr == nil {
			for _, res := range toObjectList(resPayload) {
				ip, _ := res["IPAddress"].(string)
				if ip == "" {
					continue
				}
				reservationKey := fmt.Sprintf("%s|%s", normalizedScope, strings.ToLower(ip))
				result.reservationKeys[reservationKey] = struct{}{}
			}
		}
		// Reservation errors are silently skipped — some scopes have no DHCP server role.
	}

	return result, nil
}

// collectUsers runs Get-ADUser -Filter * and returns a *dcResult with
// userKeys populated using the sid: > upn: > sam: priority chain.
func collectUsers(ctx context.Context, client *winrm.Client) (*dcResult, error) {
	const userScript = `Get-ADUser -Filter * -ErrorAction Stop -Properties SID,UserPrincipalName,SamAccountName | ` +
		`Select-Object ` +
		`@{Name='SID';Expression={if ($_.SID) { $_.SID.Value } else { $null }}},` +
		`@{Name='UserPrincipalName';Expression={$_.UserPrincipalName}},` +
		`@{Name='SamAccountName';Expression={$_.SamAccountName}} | ` +
		`ConvertTo-Json -Compress -Depth 4`

	payload, err := runPSJSON(ctx, client, userScript)
	if err != nil {
		return nil, fmt.Errorf("ad users: %w", err)
	}

	result := &dcResult{
		userKeys: make(map[string]struct{}),
	}

	for _, obj := range toObjectList(payload) {
		sid := str(obj["SID"])
		upn := str(obj["UserPrincipalName"])
		sam := str(obj["SamAccountName"])
		k := userKey(sid, upn, sam)
		if k == "" {
			continue // skip entries with no usable identifier
		}
		result.userKeys[k] = struct{}{}
	}

	return result, nil
}

// collectComputers runs Get-ADComputer -Filter * and returns a *dcResult with
// computerKeys and staticIPKeys populated.
func collectComputers(ctx context.Context, client *winrm.Client) (*dcResult, error) {
	const script = `Get-ADComputer -Filter * -Properties IPv4Address -ErrorAction Stop | ` +
		`Select-Object @{Name='Name';Expression={$_.Name}},` +
		`@{Name='IPv4Address';Expression={$_.IPv4Address}} | ` +
		`ConvertTo-Json -Compress`

	payload, err := runPSJSON(ctx, client, script)
	if err != nil {
		return nil, fmt.Errorf("ad computers: %w", err)
	}

	result := &dcResult{
		computerKeys: make(map[string]struct{}),
		staticIPKeys: make(map[string]struct{}),
	}

	for _, comp := range toObjectList(payload) {
		name := strings.ToLower(strings.TrimSpace(str(comp["Name"])))
		if name == "" {
			continue
		}
		result.computerKeys[name] = struct{}{}

		ip := strings.TrimSpace(str(comp["IPv4Address"]))
		if ip != "" {
			result.staticIPKeys[strings.ToLower(ip)] = struct{}{}
		}
	}

	return result, nil
}

// collectEventLogQPS queries the DNS Server analytical event log for the specified
// time window and returns the average queries per second. Returns (0, nil) when
// the log is disabled, empty, or inaccessible — never fails the scan.
//
// The DNS analytical log (Microsoft-Windows-DNS-Server/Analytical) is disabled by
// default on most DCs. Get-WinEvent returns a specific error for disabled logs.
// We catch this and return 0 gracefully.
var collectEventLogQPSFunc = collectEventLogQPS

func collectEventLogQPS(ctx context.Context, client *winrm.Client, windowHours int) (int, error) {
	script := fmt.Sprintf(
		`try { `+
			`$start = (Get-Date).AddHours(-%d); `+
			`$count = (Get-WinEvent -FilterHashtable @{LogName='DNS Server';StartTime=$start} -ErrorAction Stop | Measure-Object).Count; `+
			`$seconds = %d * 3600; `+
			`[math]::Ceiling($count / $seconds) `+
			`} catch { `+
			`if ($_.Exception.Message -match 'No events were found' -or `+
			`$_.Exception.Message -match 'could not be found' -or `+
			`$_.Exception.Message -match 'is not enabled' -or `+
			`$_.Exception.Message -match 'There is not an event log') { 0 } `+
			`else { 0 } }`,
		windowHours, windowHours,
	)

	output, err := runPS(ctx, client, script)
	if err != nil {
		// Graceful fallback — event log access failed entirely.
		return 0, nil
	}

	output = strings.TrimSpace(output)
	if output == "" {
		return 0, nil
	}

	qps, err := strconv.Atoi(output)
	if err != nil {
		return 0, nil
	}
	return qps, nil
}

// collectEventLogLPS queries the DHCP Server event log for the specified time
// window and returns the average leases per second. Returns (0, nil) when
// the log is disabled, empty, or inaccessible — never fails the scan.
var collectEventLogLPSFunc = collectEventLogLPS

func collectEventLogLPS(ctx context.Context, client *winrm.Client, windowHours int) (int, error) {
	script := fmt.Sprintf(
		`try { `+
			`$start = (Get-Date).AddHours(-%d); `+
			`$count = (Get-WinEvent -FilterHashtable @{LogName='DhcpAdminEvents';StartTime=$start} -ErrorAction Stop | Measure-Object).Count; `+
			`$seconds = %d * 3600; `+
			`[math]::Ceiling($count / $seconds) `+
			`} catch { `+
			`if ($_.Exception.Message -match 'No events were found' -or `+
			`$_.Exception.Message -match 'could not be found' -or `+
			`$_.Exception.Message -match 'is not enabled' -or `+
			`$_.Exception.Message -match 'There is not an event log') { 0 } `+
			`else { 0 } }`,
		windowHours, windowHours,
	)

	output, err := runPS(ctx, client, script)
	if err != nil {
		// Graceful fallback — event log access failed entirely.
		return 0, nil
	}

	output = strings.TrimSpace(output)
	if output == "" {
		return 0, nil
	}

	lps, err := strconv.Atoi(output)
	if err != nil {
		return 0, nil
	}
	return lps, nil
}

// str extracts a string value from an interface{}, returning "" for nil or non-string.
func str(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// ClientOptions configures BuildNTLMClient behavior.
type ClientOptions struct {
	useHTTPS           bool
	insecureSkipVerify bool
	port               int
}

// ClientOption is a functional option for BuildNTLMClient.
type ClientOption func(*ClientOptions)

// WithHTTPS enables TLS transport on port 5986.
func WithHTTPS() ClientOption {
	return func(o *ClientOptions) {
		o.useHTTPS = true
		o.port = 5986
	}
}

// WithInsecureSkipVerify skips TLS certificate validation (for self-signed certs).
func WithInsecureSkipVerify() ClientOption {
	return func(o *ClientOptions) {
		o.insecureSkipVerify = true
	}
}

// BuildNTLMClient constructs a WinRM client using NTLM authentication.
//
// With no options: HTTP on port 5985 with SPNEGO message-level encryption.
// With WithHTTPS(): HTTPS on port 5986 with TLS transport encryption (no SPNEGO).
// With WithInsecureSkipVerify(): skips TLS certificate validation (self-signed certs).
//
// Windows DCs require WinRM message encryption by default on HTTP — ClientNTLM
// (raw NTLM, no encryption) will be rejected. Over HTTPS, TLS provides transport
// security so SPNEGO message-level encryption is not used (avoids double-encryption
// or protocol errors on some Windows Server versions).
// Kerberos requires a domain-joined machine and is out of scope for this tool.
func BuildNTLMClient(host, username, password string, opts ...ClientOption) (*winrm.Client, error) {
	o := ClientOptions{port: winrmPort} // default: HTTP on 5985
	for _, opt := range opts {
		opt(&o)
	}

	endpoint := winrm.NewEndpoint(host, o.port, o.useHTTPS, o.insecureSkipVerify, nil, nil, nil, winrmTimeout)
	params := *winrm.DefaultParameters

	if o.useHTTPS {
		// HTTPS provides transport encryption via TLS.
		// Do NOT use SPNEGO message-level encryption over TLS — it causes
		// double-encryption or protocol errors on some Windows Server versions.
		// Use plain NTLM auth (no TransportDecorator) — TLS provides confidentiality.
		return winrm.NewClientWithParameters(endpoint, username, password, &params)
	}

	// Plain HTTP: SPNEGO message-level encryption required.
	// Windows DCs reject unencrypted WinRM sessions over HTTP.
	enc, err := winrm.NewEncryption("ntlm")
	if err != nil {
		return nil, fmt.Errorf("winrm encryption init: %w", err)
	}
	params.TransportDecorator = func() winrm.Transporter { return enc }
	return winrm.NewClientWithParameters(endpoint, username, password, &params)
}

// BuildKerberosClient constructs a WinRM client using Kerberos (SPNEGO) authentication.
// Uses pure Go gokrb5 — does not require a domain-joined machine or Windows SSPI.
// The caller must provide the Kerberos realm and KDC address (host:port).
func BuildKerberosClient(host, username, password, realm, kdc string, opts ...ClientOption) (*winrm.Client, error) {
	o := ClientOptions{port: winrmPort} // default: HTTP on 5985
	for _, opt := range opts {
		opt(&o)
	}

	endpoint := winrm.NewEndpoint(host, o.port, o.useHTTPS, o.insecureSkipVerify, nil, nil, nil, winrmTimeout)
	params := *winrm.DefaultParameters

	// Build a minimal krb5.conf programmatically.
	krbConf := krbconfig.New()
	krbConf.LibDefaults.DefaultRealm = realm
	krbConf.LibDefaults.DNSLookupKDC = false
	krbConf.LibDefaults.DNSLookupRealm = false

	// Add the realm with the KDC address.
	krbConf.Realms = append(krbConf.Realms, krbconfig.Realm{
		Realm: realm,
		KDC:   []string{kdc},
	})

	// Create a Kerberos client and obtain a TGT.
	krbClient := krbclient.NewWithPassword(username, realm, password, krbConf,
		krbclient.DisablePAFXFAST(true), // Disable PA-FX-FAST for compatibility with many DCs
	)
	defer krbClient.Destroy()

	if err := krbClient.Login(); err != nil {
		return nil, fmt.Errorf("kerberos login failed (realm=%s, kdc=%s): %w", realm, kdc, err)
	}

	// Use Kerberos (SPNEGO) transport for WinRM.
	enc, err := winrm.NewEncryption("kerberos")
	if err != nil {
		return nil, fmt.Errorf("winrm kerberos encryption init: %w", err)
	}
	params.TransportDecorator = func() winrm.Transporter { return enc }

	return winrm.NewClientWithParameters(endpoint, username, password, &params)
}

// runPS executes a PowerShell script via WinRM and returns stdout.
// Returns an error if the exit code is non-zero.
func runPS(ctx context.Context, client *winrm.Client, script string) (string, error) {
	var stdout, stderr bytes.Buffer
	exitCode, err := client.RunWithContext(ctx, winrm.Powershell(script), &stdout, &stderr)
	if err != nil {
		return "", fmt.Errorf("WinRM run error: %w", err)
	}
	if exitCode != 0 {
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = strings.TrimSpace(stdout.String())
		}
		return "", fmt.Errorf("PowerShell exited %d: %s", exitCode, errText)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// runPSJSON executes a PowerShell script and parses the JSON output.
// Returns nil if the output is empty.
func runPSJSON(ctx context.Context, client *winrm.Client, script string) (interface{}, error) {
	text, err := runPS(ctx, client, script)
	if err != nil {
		return nil, err
	}
	if text == "" {
		return nil, nil
	}
	var result interface{}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		preview := text
		if len(preview) > 200 {
			preview = preview[:200]
		}
		return nil, fmt.Errorf("PowerShell output is not valid JSON: %s", preview)
	}
	return result, nil
}

// toObjectList normalises arbitrary JSON into a []map[string]interface{}.
// Handles both JSON objects (wraps in slice) and JSON arrays.
func toObjectList(payload interface{}) []map[string]interface{} {
	if payload == nil {
		return nil
	}
	switch v := payload.(type) {
	case []interface{}:
		result := make([]map[string]interface{}, 0, len(v))
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				result = append(result, m)
			}
		}
		return result
	case map[string]interface{}:
		return []map[string]interface{}{v}
	}
	return nil
}

// psQuote escapes a string for single-quote use in PowerShell.
func psQuote(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// ceilDiv computes ceiling(n / d). Returns 0 if n is 0.
func ceilDiv(n, d int) int {
	if n == 0 || d == 0 {
		return 0
	}
	return (n + d - 1) / d
}
