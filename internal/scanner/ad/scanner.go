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
	"strings"
	"sync"
	"time"

	"github.com/masterzen/winrm"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

const (
	winrmPort        = 5985
	winrmTimeout     = 60 * time.Second
	maxConcurrentDCs = 3
)

// Scanner implements scanner.Scanner for Active Directory using WinRM over NTLM.
type Scanner struct{}

// New returns a ready-to-use AD Scanner.
func New() *Scanner { return &Scanner{} }

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
	computerName    string
}

// dcAggregator accumulates dcResult values from multiple DCs under a caller-held mutex.
type dcAggregator struct {
	zoneNames       map[string]struct{}
	recordKeys      map[string]struct{}
	scopeIDs        map[string]struct{}
	leaseKeys       map[string]struct{}
	reservationKeys map[string]struct{}
	userKeys        map[string]struct{}
	dcNames         []string
}

// init allocates all maps. Call before the first merge.
func (a *dcAggregator) init() {
	a.zoneNames = make(map[string]struct{})
	a.recordKeys = make(map[string]struct{})
	a.scopeIDs = make(map[string]struct{})
	a.leaseKeys = make(map[string]struct{})
	a.reservationKeys = make(map[string]struct{})
	a.userKeys = make(map[string]struct{})
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
	if r.computerName != "" {
		a.dcNames = append(a.dcNames, r.computerName)
	}
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

// Scan satisfies scanner.Scanner. It reads req.Credentials["servers"] (comma-separated
// list of DC hostnames), fans out concurrently (up to maxConcurrentDCs), aggregates
// results via dcAggregator, then emits 6 FindingRows.
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

	agg := scanAllDCs(ctx, hosts, username, password, publish)
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

	findings := []calculator.FindingRow{
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
	}

	return findings, nil
}

// scanAllDCs fans out to all DCs concurrently (up to maxConcurrentDCs), merges
// results via dcAggregator, and returns the aggregated totals.
func scanAllDCs(ctx context.Context, hosts []string, username, password string, publish func(scanner.Event)) *dcAggregator {
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

			result := scanOneDC(ctx, host, username, password, publish)
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

// scanOneDC connects to a single DC and collects DNS, DHCP, and user data.
// Returns nil on connection failure (error is published as an event). Per-resource
// errors are isolated: a DNS failure does not prevent DHCP or user collection.
func scanOneDC(ctx context.Context, host, username, password string, publish func(scanner.Event)) *dcResult {
	client, err := BuildNTLMClient(host, username, password)
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

// str extracts a string value from an interface{}, returning "" for nil or non-string.
func str(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// BuildNTLMClient constructs a WinRM client using NTLM with message-level encryption
// (SPNEGO session encryption, HTTP port 5985). Windows DCs require WinRM message
// encryption by default — ClientNTLM (raw NTLM, no encryption) will be rejected with
// a 401 or 500. winrm.NewEncryption("ntlm") uses bodgit/ntlmssp which implements the
// full NTLM + SPNEGO multipart/encrypted framing that DCs expect.
// Kerberos requires a domain-joined machine and is out of scope for this tool.
func BuildNTLMClient(host, username, password string) (*winrm.Client, error) {
	endpoint := winrm.NewEndpoint(host, winrmPort, false, false, nil, nil, nil, winrmTimeout)
	params := *winrm.DefaultParameters
	enc, err := winrm.NewEncryption("ntlm")
	if err != nil {
		return nil, fmt.Errorf("winrm encryption init: %w", err)
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
