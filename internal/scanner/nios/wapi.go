// Package nios provides NIOS scanning capabilities.
// wapi.go implements the NIOS WAPI live scanner that connects to a NIOS Grid Manager
// via REST API, auto-detects the WAPI version, fetches the capacity report, and produces
// FindingRows + NiosServerMetrics.
package nios

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// Regex patterns for WAPI version detection, ported from Python reference.
var (
	wapiVersionRE    = regexp.MustCompile(`(?i)/wapi/v(?P<version>\d+(?:\.\d+)+)`)
	wapiDocVersionRE = regexp.MustCompile(`(?i)v?(\d+(?:\.\d+)+)`)
)

// wapiProbeCandidates is the ordered list of WAPI versions to probe, from newest to oldest.
// Matches _WAPI_PROBE_CANDIDATES from the Python reference.
var wapiProbeCandidates = []string{
	"2.13.7",
	"2.13.6",
	"2.13.5",
	"2.13.4",
	"2.12.3",
	"2.12.2",
	"2.11.3",
	"2.10.5",
	"2.9.13",
}

// supportedDNSRecordTypes matches SUPPORTED_DNS_RECORD_TYPES from Python constants.py.
var supportedDNSRecordTypes = map[string]struct{}{
	"A": {}, "AAAA": {}, "CNAME": {}, "MX": {}, "TXT": {},
	"CAA": {}, "SRV": {}, "SVCB": {}, "HTTPS": {}, "PTR": {},
	"NS": {}, "SOA": {}, "NAPTR": {},
}

// WAPIScanner implements the NIOS WAPI live scanner.
// It satisfies both scanner.Scanner and scanner.NiosResultScanner interfaces.
type WAPIScanner struct {
	mu              sync.Mutex
	metrics         []NiosServerMetric
	baseURL         string
	username        string
	password        string
	explicitVersion string
	skipTLS         bool
}

// NewWAPI returns a new WAPIScanner instance.
func NewWAPI() *WAPIScanner {
	return &WAPIScanner{}
}

// makeHTTPClient creates a new http.Client, optionally with InsecureSkipVerify.
// NEVER modifies http.DefaultTransport.
func (ws *WAPIScanner) makeHTTPClient(skipVerify bool) *http.Client {
	if !skipVerify {
		return &http.Client{}
	}
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: true, //nolint:gosec // user-opted-in skip for self-signed certs
			},
		},
	}
}

// GetNiosServerMetricsJSON returns JSON-encoded []NiosServerMetric after Scan() completes.
func (ws *WAPIScanner) GetNiosServerMetricsJSON() []byte {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	if len(ws.metrics) == 0 {
		return nil
	}
	data, err := json.Marshal(ws.metrics)
	if err != nil {
		return nil
	}
	return data
}

// Scan implements scanner.Scanner for WAPI live scanning.
func (ws *WAPIScanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	// Extract credentials.
	ws.baseURL = strings.TrimRight(req.Credentials["wapi_url"], "/")
	ws.username = req.Credentials["wapi_username"]
	ws.password = req.Credentials["wapi_password"]
	ws.explicitVersion = sanitizeWAPIVersion(req.Credentials["wapi_version"])
	ws.skipTLS = req.Credentials["skip_tls"] == "true"

	if ws.baseURL == "" {
		return nil, fmt.Errorf("nios wapi: wapi_url not set in credentials")
	}
	if ws.username == "" || ws.password == "" {
		return nil, fmt.Errorf("nios wapi: wapi_username and wapi_password are required")
	}

	// Normalize base URL: strip embedded /wapi/vX.Y.Z path but keep it for version detection.
	ws.baseURL = normalizeBaseURL(ws.baseURL)

	client := ws.makeHTTPClient(ws.skipTLS)

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "wapi_version_resolve",
		Status:   "started",
	})

	version, err := ws.resolveVersion(client)
	if err != nil {
		return nil, fmt.Errorf("nios wapi: version resolution failed: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "wapi_version",
		Message:  version,
	})

	// Fetch capacity report.
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "capacityreport",
		Status:   "started",
	})

	report, err := ws.fetchCapacityReport(client, version)
	if err != nil {
		return nil, fmt.Errorf("nios wapi: capacity report fetch failed: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "capacityreport",
		Count:    len(report),
		Status:   "done",
	})

	// Parse selected members filter.
	selectedSet := make(map[string]struct{})
	for _, sub := range req.Subscriptions {
		sub = strings.TrimSpace(sub)
		if sub != "" {
			selectedSet[sub] = struct{}{}
		}
	}

	// Process capacity report into FindingRows and NiosServerMetrics.
	var allRows []calculator.FindingRow
	var metrics []NiosServerMetric

	for _, member := range report {
		memberName := strings.TrimSpace(fmt.Sprintf("%v", member["name"]))
		if memberName == "" {
			continue
		}

		// Apply subscription filter if non-empty.
		if len(selectedSet) > 0 {
			if _, ok := selectedSet[memberName]; !ok {
				continue
			}
		}

		totalObjects := safeInt(member["total_objects"])

		// Parse object_counts.
		objectCountsRaw, _ := json.Marshal(member["object_counts"])
		counts := iterObjectCounts(objectCountsRaw)

		for _, oc := range counts {
			row := classifyMetric(oc.typeName, oc.count)
			if row == nil {
				continue
			}
			row.Provider = "nios"
			row.Source = memberName
			allRows = append(allRows, *row)
		}

		// Build NiosServerMetric.
		role := fmt.Sprintf("%v", member["role"])
		metrics = append(metrics, NiosServerMetric{
			MemberID:    memberName,
			MemberName:  memberName,
			Role:        role,
			QPS:         0,
			LPS:         0,
			ObjectCount: totalObjects,
		})

		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: "nios",
			Resource: "member",
			Message:  memberName,
			Count:    totalObjects,
		})
	}

	ws.mu.Lock()
	ws.metrics = metrics
	ws.mu.Unlock()

	return allRows, nil
}

// resolveVersion implements the 4-step version resolution cascade.
// client may be nil if explicitVersion or embedded version is expected to match.
func (ws *WAPIScanner) resolveVersion(client *http.Client) (string, error) {
	// Step 1: Explicit version override.
	if ws.explicitVersion != "" {
		return ws.explicitVersion, nil
	}

	// Step 2: Embedded version in the original URL.
	if embedded := extractEmbeddedVersion(ws.baseURL); embedded != "" {
		return embedded, nil
	}

	// Steps 3+4 require an HTTP client.
	if client == nil {
		return "", fmt.Errorf("nios wapi: cannot resolve version without HTTP client")
	}

	// Step 3: Probe wapidoc page.
	if ver := ws.resolveVersionFromWapidoc(client); ver != "" {
		return ver, nil
	}

	// Step 4: Probe candidate versions.
	return ws.probeCandidateVersions(client)
}

// resolveVersionFromWapidoc fetches /wapidoc/ and parses version links from HTML.
func (ws *WAPIScanner) resolveVersionFromWapidoc(client *http.Client) string {
	url := ws.baseURL + "/wapidoc/"
	resp, err := client.Get(url)
	if err != nil || resp.StatusCode >= 400 {
		return ""
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return ""
	}
	versions := parseWapidocVersions(string(body))
	if len(versions) > 0 {
		return versions[0]
	}
	return ""
}

// probeCandidateVersions tries known WAPI versions from newest to oldest.
func (ws *WAPIScanner) probeCandidateVersions(client *http.Client) (string, error) {
	for _, version := range wapiProbeCandidates {
		url := fmt.Sprintf("%s/wapi/v%s/grid?_max_results=1&_return_fields=_ref", ws.baseURL, version)
		req, _ := http.NewRequest("GET", url, nil)
		req.SetBasicAuth(ws.username, ws.password)

		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()

		if resp.StatusCode < 400 {
			return version, nil
		}
		if resp.StatusCode == 401 || resp.StatusCode == 403 {
			return "", fmt.Errorf("nios wapi: authentication failed (HTTP %d)", resp.StatusCode)
		}
		// 404 = version not supported, continue.
	}
	return "", fmt.Errorf("nios wapi: unable to resolve WAPI version; set wapi_version explicitly or enable /wapidoc/")
}

// fetchCapacityReport fetches the capacity report from the WAPI.
func (ws *WAPIScanner) fetchCapacityReport(client *http.Client, version string) ([]map[string]interface{}, error) {
	url := fmt.Sprintf("%s/wapi/v%s/capacityreport?_return_fields=name,hardware_type,max_capacity,object_counts,percent_used,role,total_objects",
		ws.baseURL, version)
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(ws.username, ws.password)

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("capacityreport returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Try parsing as JSON array first.
	var members []map[string]interface{}
	if err := json.Unmarshal(body, &members); err == nil {
		return members, nil
	}

	// Try parsing as JSON object with result/results/data key.
	var wrapper map[string]interface{}
	if err := json.Unmarshal(body, &wrapper); err == nil {
		for _, key := range []string{"result", "results", "data"} {
			if val, ok := wrapper[key]; ok {
				if arr, ok := val.([]interface{}); ok {
					result := make([]map[string]interface{}, 0, len(arr))
					for _, item := range arr {
						if m, ok := item.(map[string]interface{}); ok {
							result = append(result, m)
						}
					}
					return result, nil
				}
			}
		}
	}

	return nil, fmt.Errorf("unexpected capacity report format")
}

// objectCount holds a type_name/count pair from the capacity report.
type objectCount struct {
	typeName string
	count    int
}

// iterObjectCounts parses the object_counts field from a capacity report member.
// Handles both list-of-dicts ([{type_name, count}]) and dict-of-counts ({name: count}) formats.
func iterObjectCounts(raw json.RawMessage) []objectCount {
	if len(raw) == 0 {
		return nil
	}

	// Try list-of-dicts format: [{type_name: "X", count: N}, ...]
	var listFormat []map[string]interface{}
	if err := json.Unmarshal(raw, &listFormat); err == nil && len(listFormat) > 0 {
		var result []objectCount
		for _, item := range listFormat {
			typeName := ""
			if v, ok := item["type_name"]; ok {
				typeName = strings.TrimSpace(fmt.Sprintf("%v", v))
			} else if v, ok := item["name"]; ok {
				typeName = strings.TrimSpace(fmt.Sprintf("%v", v))
			}
			if typeName == "" {
				continue
			}
			count := safeInt(item["count"])
			if count < 0 {
				count = 0
			}
			result = append(result, objectCount{typeName: typeName, count: count})
		}
		return result
	}

	// Try dict format: {"DNS Zones": 10, ...}
	var dictFormat map[string]interface{}
	if err := json.Unmarshal(raw, &dictFormat); err == nil {
		var result []objectCount
		for key, val := range dictFormat {
			typeName := strings.TrimSpace(key)
			if typeName == "" {
				continue
			}
			count := safeInt(val)
			if count < 0 {
				count = 0
			}
			result = append(result, objectCount{typeName: typeName, count: count})
		}
		return result
	}

	return nil
}

// classifyMetric maps a capacity report type_name and count to a FindingRow.
// Ported from _apply_metric() in the Python reference.
// Returns nil if the metric type is unrecognized or count is zero.
func classifyMetric(typeName string, count int) *calculator.FindingRow {
	if count <= 0 {
		return nil
	}

	normalized := normalizeTypeName(typeName)
	parts := strings.Fields(normalized)

	// --- DNS classification ---
	if isDNSRelated(typeName, normalized) {
		return classifyDNSMetric(typeName, normalized, parts, count)
	}

	// --- IPAM classification ---
	isV6 := containsAny(parts, func(p string) bool {
		return strings.Contains(p, "ipv6") || strings.Contains(p, "ip6") || strings.HasSuffix(p, "v6")
	})
	hasDHCP := containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "dhcp") })
	hasLease := containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "lease") })

	// DHCP Leases -> Active IPs
	if hasDHCP && hasLease {
		item := "NIOS DHCPv4 Leases"
		if isV6 {
			item = "NIOS DHCPv6 Leases"
		}
		return &calculator.FindingRow{
			Category:         calculator.CategoryActiveIPs,
			Item:             item,
			Count:            count,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: ceilDiv(count, calculator.TokensPerActiveIP),
		}
	}

	// IPAM Blocks -> DDI Objects
	if containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "block") }) {
		prefix := "IPv4"
		if isV6 {
			prefix = "IPv6"
		}
		return &calculator.FindingRow{
			Category:         calculator.CategoryDDIObjects,
			Item:             "NIOS " + prefix + " Blocks",
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		}
	}

	// IPAM Networks -> DDI Objects
	if containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "network") }) {
		prefix := "IPv4"
		if isV6 {
			prefix = "IPv6"
		}
		return &calculator.FindingRow{
			Category:         calculator.CategoryDDIObjects,
			Item:             "NIOS " + prefix + " Networks",
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		}
	}

	// IPAM Addresses -> DDI Objects
	if containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "address") }) {
		prefix := "IPv4"
		if isV6 {
			prefix = "IPv6"
		}
		return &calculator.FindingRow{
			Category:         calculator.CategoryDDIObjects,
			Item:             "NIOS " + prefix + " Addresses",
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		}
	}

	return nil
}

// classifyDNSMetric handles DNS-related type classification.
func classifyDNSMetric(typeName, normalized string, parts []string, count int) *calculator.FindingRow {
	// DNS Views
	if containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "view") }) {
		return &calculator.FindingRow{
			Category:         calculator.CategoryDDIObjects,
			Item:             "NIOS DNS Views",
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		}
	}

	// DNS Zones
	if containsAny(parts, func(p string) bool { return strings.HasPrefix(p, "zone") }) {
		return &calculator.FindingRow{
			Category:         calculator.CategoryDDIObjects,
			Item:             "NIOS DNS Zones",
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		}
	}

	// DNS Records
	if isDNSRecordMetric(parts) {
		// Check for "unsupported" keyword.
		if containsToken(parts, "unsupported") {
			return &calculator.FindingRow{
				Category:         calculator.CategoryDDIObjects,
				Item:             "NIOS DNS Records (Unsupported Types)",
				Count:            count,
				TokensPerUnit:    calculator.TokensPerDDIObject,
				ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
			}
		}

		// Try to extract a specific record type.
		rrtype := extractRecordType(typeName)
		if rrtype != "" {
			if _, supported := supportedDNSRecordTypes[rrtype]; supported {
				return &calculator.FindingRow{
					Category:         calculator.CategoryDDIObjects,
					Item:             "NIOS DNS Records (Supported Types)",
					Count:            count,
					TokensPerUnit:    calculator.TokensPerDDIObject,
					ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
				}
			}
			// Known record type but not in supported set.
			return &calculator.FindingRow{
				Category:         calculator.CategoryDDIObjects,
				Item:             "NIOS DNS Records (Unsupported Types)",
				Count:            count,
				TokensPerUnit:    calculator.TokensPerDDIObject,
				ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
			}
		}

		// Generic DNS record (supported assumed per Python reference).
		return &calculator.FindingRow{
			Category:         calculator.CategoryDDIObjects,
			Item:             "NIOS DNS Records (Supported Types)",
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		}
	}

	// Fallback for other DNS-related metrics.
	return &calculator.FindingRow{
		Category:         calculator.CategoryDDIObjects,
		Item:             "NIOS DNS Records (Supported Types)",
		Count:            count,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
	}
}

// --- Helper functions ported from Python reference ---

// normalizeTypeName lowercases and strips non-alphanumeric characters.
func normalizeTypeName(typeName string) string {
	re := regexp.MustCompile(`[^a-z0-9]+`)
	return strings.TrimSpace(re.ReplaceAllString(strings.ToLower(typeName), " "))
}

// extractEmbeddedVersion finds /wapi/vX.Y.Z in a URL.
func extractEmbeddedVersion(url string) string {
	match := wapiVersionRE.FindStringSubmatch(url)
	if len(match) < 2 {
		return ""
	}
	return sanitizeWAPIVersion(match[1])
}

// normalizeBaseURL strips the /wapi/vX.Y.Z suffix from a URL.
func normalizeBaseURL(baseURL string) string {
	loc := wapiVersionRE.FindStringIndex(baseURL)
	if loc != nil {
		baseURL = baseURL[:loc[0]]
	}
	return strings.TrimRight(baseURL, "/")
}

// sanitizeWAPIVersion cleans a version string.
func sanitizeWAPIVersion(version string) string {
	v := strings.TrimSpace(version)
	if strings.HasPrefix(strings.ToLower(v), "v") {
		v = v[1:]
	}
	if v == "" {
		return ""
	}
	return v
}

// parseWapidocVersions extracts version strings from wapidoc HTML and returns them
// sorted highest first.
func parseWapidocVersions(html string) []string {
	matches := wapiDocVersionRE.FindAllStringSubmatch(html, -1)
	seen := make(map[string]struct{})
	var versions []string
	for _, m := range matches {
		ver := m[1]
		if !strings.Contains(ver, ".") {
			continue
		}
		if _, ok := seen[ver]; ok {
			continue
		}
		seen[ver] = struct{}{}
		versions = append(versions, ver)
	}
	sort.Slice(versions, func(i, j int) bool {
		return compareVersions(versions[i], versions[j]) > 0
	})
	return versions
}

// compareVersions compares two dotted version strings.
// Returns positive if a > b, negative if a < b, zero if equal.
func compareVersions(a, b string) int {
	ap := strings.Split(a, ".")
	bp := strings.Split(b, ".")
	maxLen := len(ap)
	if len(bp) > maxLen {
		maxLen = len(bp)
	}
	for i := 0; i < maxLen; i++ {
		var av, bv int
		if i < len(ap) {
			av, _ = strconv.Atoi(ap[i])
		}
		if i < len(bp) {
			bv, _ = strconv.Atoi(bp[i])
		}
		if av != bv {
			return av - bv
		}
	}
	return 0
}

// isDNSRelated checks if a type name is DNS-related.
func isDNSRelated(typeName, normalized string) bool {
	if normalized == "" {
		return false
	}
	if extractRecordType(typeName) != "" {
		return true
	}
	dnsTokens := map[string]struct{}{
		"dns": {}, "zone": {}, "zones": {}, "view": {}, "views": {},
		"record": {}, "records": {}, "rr": {}, "rrset": {},
		"host": {}, "delegation": {}, "forward": {}, "reverse": {},
	}
	for _, part := range strings.Fields(normalized) {
		if _, ok := dnsTokens[part]; ok {
			return true
		}
	}
	return false
}

// isDNSRecordMetric checks if the parts indicate a DNS record type metric.
func isDNSRecordMetric(parts []string) bool {
	for _, p := range parts {
		if strings.HasPrefix(p, "record") {
			return true
		}
	}
	return containsToken(parts, "rr") || containsToken(parts, "rrset")
}

// extractRecordType extracts a DNS record type from a type name.
func extractRecordType(typeName string) string {
	re := regexp.MustCompile(`[^A-Z0-9]+`)
	tokenized := strings.Fields(re.ReplaceAllString(strings.ToUpper(typeName), " "))
	for _, token := range tokenized {
		if _, ok := supportedDNSRecordTypes[token]; ok {
			return token
		}
	}

	// Check for record/records in tokenized form.
	hasRecord := false
	for _, token := range tokenized {
		if token == "RECORD" || token == "RECORDS" {
			hasRecord = true
			break
		}
	}
	if hasRecord {
		ignore := map[string]struct{}{
			"DNS": {}, "RECORD": {}, "RECORDS": {}, "TYPE": {}, "TYPES": {},
			"SUPPORTED": {}, "UNSUPPORTED": {}, "TOTAL": {}, "OBJECT": {},
			"OBJECTS": {}, "COUNT": {}, "COUNTS": {}, "RESOURCE": {}, "RESOURCES": {},
		}
		for _, token := range tokenized {
			if _, skip := ignore[token]; skip {
				continue
			}
			if isAlpha(token) && len(token) >= 1 && len(token) <= 10 {
				return token
			}
		}
	}
	return ""
}

// containsAny checks if any element in parts satisfies the predicate.
func containsAny(parts []string, pred func(string) bool) bool {
	for _, p := range parts {
		if pred(p) {
			return true
		}
	}
	return false
}

// containsToken checks for exact token match in parts.
func containsToken(parts []string, token string) bool {
	for _, p := range parts {
		if p == token {
			return true
		}
	}
	return false
}

// isAlpha checks if a string contains only ASCII letters.
func isAlpha(s string) bool {
	for _, c := range s {
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
			return false
		}
	}
	return len(s) > 0
}

// safeInt converts an interface value to int, handling float64 from JSON.
func safeInt(v interface{}) int {
	switch val := v.(type) {
	case float64:
		return int(val)
	case int:
		return val
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(val))
		return n
	case json.Number:
		n, _ := val.Int64()
		return int(n)
	}
	return 0
}
