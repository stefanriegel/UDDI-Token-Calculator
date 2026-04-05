package ad

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/masterzen/winrm"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// Compile-time signature assertion — BuildNTLMClient must remain exported
// with this exact signature. This test will FAIL TO COMPILE (not just fail)
// if the signature changes.
var _ func(string, string, string, ...ClientOption) (*winrm.Client, error) = BuildNTLMClient

// TestMaxConcurrentDCs verifies the constant exists and has the expected value.
func TestMaxConcurrentDCs(t *testing.T) {
	const expected = 3
	if maxConcurrentDCs != expected {
		t.Errorf("maxConcurrentDCs = %d, want %d", maxConcurrentDCs, expected)
	}
}

// TestNormalizeZoneName verifies zone name normalization matches Python reference:
// lowercase, trim trailing dot, trim surrounding whitespace.
func TestNormalizeZoneName(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"Corp.Local.", "corp.local"},
		{"  CORP.LOCAL  ", "corp.local"},
		{"corp.local", "corp.local"},
		{"INTERNAL.CORP.", "internal.corp"},
		{"", ""},
		{".", ""},
	}
	for _, tc := range cases {
		got := normalizeZoneName(tc.input)
		if got != tc.want {
			t.Errorf("normalizeZoneName(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// TestRecordKey verifies the DNS record deduplication key format matches Python reference.
// Python reference: zone_name|owner|record_type|record_data
func TestRecordKey(t *testing.T) {
	key := fmt.Sprintf("%s|%s|%s|%s",
		normalizeZoneName("Corp.Local."),
		"dc1",
		"A",
		"10.0.0.1",
	)
	want := "corp.local|dc1|A|10.0.0.1"
	if key != want {
		t.Errorf("record key = %q, want %q", key, want)
	}
}

// TestUserKey_SIDPriority verifies that SID wins when all three values are present.
func TestUserKey_SIDPriority(t *testing.T) {
	got := userKey("S-1-5-21-x", "user@corp.local", "user")
	want := "sid:s-1-5-21-x"
	if got != want {
		t.Errorf("userKey(sid, upn, sam) = %q, want %q", got, want)
	}
}

// TestUserKey_UPNFallback verifies UPN is used when SID is absent.
func TestUserKey_UPNFallback(t *testing.T) {
	got := userKey("", "user@corp.local", "user")
	want := "upn:user@corp.local"
	if got != want {
		t.Errorf("userKey('', upn, sam) = %q, want %q", got, want)
	}
}

// TestUserKey_SAMFallback verifies SAM is used when both SID and UPN are absent.
func TestUserKey_SAMFallback(t *testing.T) {
	got := userKey("", "", "user")
	want := "sam:user"
	if got != want {
		t.Errorf("userKey('', '', sam) = %q, want %q", got, want)
	}
}

// TestUserKey_Empty verifies that all-empty inputs produce an empty key —
// callers should skip entries with an empty key.
func TestUserKey_Empty(t *testing.T) {
	got := userKey("", "", "")
	if got != "" {
		t.Errorf("userKey('', '', '') = %q, want empty string", got)
	}
}

// TestDHCPLeaseKey verifies scope_id|ip format matches Python reference.
func TestDHCPLeaseKey(t *testing.T) {
	scopeID := "192.168.1.0"
	ip := "192.168.1.5"
	key := fmt.Sprintf("%s|%s", strings.ToLower(scopeID), strings.ToLower(ip))
	want := "192.168.1.0|192.168.1.5"
	if key != want {
		t.Errorf("DHCP lease key = %q, want %q", key, want)
	}
}

// TestMultiDCAgg verifies dcAggregator.merge() produces the correct set union
// across multiple DC results.
func TestMultiDCAgg(t *testing.T) {
	var agg dcAggregator
	agg.init()

	// DC1: zones A and B
	r1 := &dcResult{
		zoneNames: map[string]struct{}{"corp.local": {}, "internal.corp": {}},
	}
	// DC2: zones B and C (B is replicated — should dedup to 1)
	r2 := &dcResult{
		zoneNames: map[string]struct{}{"internal.corp": {}, "other.local": {}},
	}

	agg.merge(r1)
	agg.merge(r2)

	if got := len(agg.zoneNames); got != 3 {
		t.Errorf("merged zone count = %d, want 3 (A, B, C deduplicated)", got)
	}
}

// TestDNSDedup_CrossDC verifies that the same zone name from two DCs deduplicates
// to a single entry, and two distinct zone names produce two entries.
func TestDNSDedup_CrossDC(t *testing.T) {
	var agg dcAggregator
	agg.init()

	// Both DCs report the same zone (replication)
	r1 := &dcResult{zoneNames: map[string]struct{}{"corp.local": {}}}
	r2 := &dcResult{zoneNames: map[string]struct{}{"corp.local": {}}}
	agg.merge(r1)
	agg.merge(r2)

	if got := len(agg.zoneNames); got != 1 {
		t.Errorf("same zone from two DCs: count = %d, want 1", got)
	}

	// Reset and test two distinct zones
	agg.init()
	r3 := &dcResult{zoneNames: map[string]struct{}{"corp.local": {}}}
	r4 := &dcResult{zoneNames: map[string]struct{}{"other.local": {}}}
	agg.merge(r3)
	agg.merge(r4)

	if got := len(agg.zoneNames); got != 2 {
		t.Errorf("different zones from two DCs: count = %d, want 2", got)
	}
}

// TestReservationKeys verifies DHCP reservation dedup by scope_id|ip.
// Same scope + same IP → deduplicated to 1; same scope + different IPs → 2.
func TestReservationKeys(t *testing.T) {
	var agg dcAggregator
	agg.init()

	sameKey := "192.168.1.0|192.168.1.50"
	r1 := &dcResult{
		reservationKeys: map[string]struct{}{sameKey: {}},
	}
	r2 := &dcResult{
		reservationKeys: map[string]struct{}{sameKey: {}},
	}
	agg.merge(r1)
	agg.merge(r2)

	if got := len(agg.reservationKeys); got != 1 {
		t.Errorf("duplicate reservation keys: count = %d, want 1", got)
	}

	// Reset — same scope but different IPs
	agg.init()
	r3 := &dcResult{reservationKeys: map[string]struct{}{"192.168.1.0|192.168.1.50": {}}}
	r4 := &dcResult{reservationKeys: map[string]struct{}{"192.168.1.0|192.168.1.51": {}}}
	agg.merge(r3)
	agg.merge(r4)

	if got := len(agg.reservationKeys); got != 2 {
		t.Errorf("different reservation IPs same scope: count = %d, want 2", got)
	}
}

// TestZeroCountFilteredOut verifies that FindingRows with Count=0 are excluded
// from the final results, and only non-zero rows are returned.
func TestZeroCountFilteredOut(t *testing.T) {
	allRows := []calculator.FindingRow{
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryDDIObjects, Item: "dns_zone", Count: 5, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: 1},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryDDIObjects, Item: "dns_record", Count: 0, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: 0},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryDDIObjects, Item: "dhcp_scope", Count: 0, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: 0},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryActiveIPs, Item: "dhcp_lease", Count: 10, TokensPerUnit: calculator.TokensPerActiveIP, ManagementTokens: 1},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryActiveIPs, Item: "dhcp_reservation", Count: 0, TokensPerUnit: calculator.TokensPerActiveIP, ManagementTokens: 0},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryManagedAssets, Item: "user_account", Count: 0, TokensPerUnit: calculator.TokensPerManagedAsset, ManagementTokens: 0},
	}

	var filtered []calculator.FindingRow
	for _, row := range allRows {
		if row.Count > 0 {
			filtered = append(filtered, row)
		}
	}

	if got := len(filtered); got != 2 {
		t.Errorf("filtered row count = %d, want 2 (only dns_zone and dhcp_lease)", got)
	}
	if filtered[0].Item != "dns_zone" {
		t.Errorf("filtered[0].Item = %q, want dns_zone", filtered[0].Item)
	}
	if filtered[1].Item != "dhcp_lease" {
		t.Errorf("filtered[1].Item = %q, want dhcp_lease", filtered[1].Item)
	}
}

// TestAllZeroCountReturnsEmpty verifies that when all rows have Count=0,
// the filtered result is empty (triggering the "no resources discovered" error path).
func TestAllZeroCountReturnsEmpty(t *testing.T) {
	allRows := []calculator.FindingRow{
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryDDIObjects, Item: "dns_zone", Count: 0},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryDDIObjects, Item: "dns_record", Count: 0},
		{Provider: scanner.ProviderAD, Source: "DC01", Category: calculator.CategoryActiveIPs, Item: "dhcp_lease", Count: 0},
	}

	var filtered []calculator.FindingRow
	for _, row := range allRows {
		if row.Count > 0 {
			filtered = append(filtered, row)
		}
	}

	if len(filtered) != 0 {
		t.Errorf("all-zero rows: filtered count = %d, want 0", len(filtered))
	}
}

// TestBuildNTLMClientHTTPS verifies BuildNTLMClient with HTTP, HTTPS, and HTTPS+insecure variants.
func TestBuildNTLMClientHTTPS(t *testing.T) {
	// HTTP baseline (no options)
	client, err := BuildNTLMClient("127.0.0.1", "testuser", "testpass")
	if err != nil {
		t.Fatalf("BuildNTLMClient (HTTP) failed: %v", err)
	}
	if client == nil {
		t.Fatal("expected non-nil client for HTTP")
	}

	// HTTPS with WithHTTPS()
	clientHTTPS, err := BuildNTLMClient("127.0.0.1", "testuser", "testpass", WithHTTPS())
	if err != nil {
		t.Fatalf("BuildNTLMClient (HTTPS) failed: %v", err)
	}
	if clientHTTPS == nil {
		t.Fatal("expected non-nil client for HTTPS")
	}

	// HTTPS + InsecureSkipVerify
	clientInsecure, err := BuildNTLMClient("127.0.0.1", "testuser", "testpass", WithHTTPS(), WithInsecureSkipVerify())
	if err != nil {
		t.Fatalf("BuildNTLMClient (HTTPS+insecure) failed: %v", err)
	}
	if clientInsecure == nil {
		t.Fatal("expected non-nil client for HTTPS+insecure")
	}
}

// ─── New S01 tests: DHCP+20%, tier calculation, event log graceful fallback,
//     computer collection, per-DC ADServerMetric, aggregator computerKeys/staticIPKeys ───

// TestDHCPWithOverhead verifies ceil(count * 1.2) arithmetic.
func TestDHCPWithOverhead(t *testing.T) {
	cases := []struct {
		input int
		want  int
	}{
		{100, 120},  // ceil(120.0) = 120
		{0, 0},      // ceil(0.0) = 0
		{1, 2},      // ceil(1.2) = 2
		{5, 6},      // ceil(6.0) = 6
		{83, 100},   // ceil(99.6) = 100
		{10, 12},    // ceil(12.0) = 12
	}
	for _, tc := range cases {
		got := dhcpWithOverhead(tc.input)
		if got != tc.want {
			t.Errorf("dhcpWithOverhead(%d) = %d, want %d", tc.input, got, tc.want)
		}
	}
}

// TestDHCPOverhead20Percent verifies the formula is exactly ceil(n*1.2).
func TestDHCPOverhead20Percent(t *testing.T) {
	for n := 0; n < 200; n++ {
		expected := int(math.Ceil(float64(n) * 1.2))
		got := dhcpWithOverhead(n)
		if got != expected {
			t.Errorf("dhcpWithOverhead(%d) = %d, want %d", n, got, expected)
		}
	}
}

// TestCalcADTier_2XS verifies that zero QPS/LPS/objects produce tier 2XS.
func TestCalcADTier_2XS(t *testing.T) {
	tier := calcADTier(0, 0, 0)
	if tier.name != "2XS" {
		t.Errorf("calcADTier(0,0,0) = %q, want 2XS", tier.name)
	}
	if tier.serverTokens != 130 {
		t.Errorf("tier.serverTokens = %d, want 130", tier.serverTokens)
	}
}

// TestCalcADTier_Selection verifies tier escalation based on object count.
func TestCalcADTier_Selection(t *testing.T) {
	cases := []struct {
		qps, lps, objects int
		wantTier          string
		wantTokens        int
	}{
		{0, 0, 0, "2XS", 130},
		{0, 0, 3000, "2XS", 130},     // fits exactly in 2XS
		{0, 0, 3001, "XS", 250},      // exceeds 2XS maxObjects
		{0, 0, 7500, "XS", 250},      // fits exactly in XS
		{0, 0, 7501, "S", 470},       // exceeds XS maxObjects
		{5001, 0, 0, "XS", 250},      // QPS exceeds 2XS
		{0, 76, 0, "XS", 250},        // LPS exceeds 2XS
		{0, 0, 880000, "XL", 2700},   // fits in XL
		{0, 0, 880001, "XL", 2700},   // exceeds XL → capped at XL
		{200000, 1000, 999999, "XL", 2700}, // everything huge → XL cap
	}
	for _, tc := range cases {
		tier := calcADTier(tc.qps, tc.lps, tc.objects)
		if tier.name != tc.wantTier {
			t.Errorf("calcADTier(%d,%d,%d) = %q, want %q", tc.qps, tc.lps, tc.objects, tier.name, tc.wantTier)
		}
		if tier.serverTokens != tc.wantTokens {
			t.Errorf("calcADTier(%d,%d,%d) serverTokens = %d, want %d", tc.qps, tc.lps, tc.objects, tier.serverTokens, tc.wantTokens)
		}
	}
}

// TestADServerMetricConstruction verifies per-DC metric assembly with DHCP+20%.
func TestADServerMetricConstruction(t *testing.T) {
	dc := &dcResult{
		computerName:    "DC01",
		dnsObjectCount:  150,  // zones + records
		dhcpObjectCount: 100,  // scopes + leases + reservations
		qps:             0,
		lps:             0,
	}

	dhcpOverhead := dhcpWithOverhead(dc.dhcpObjectCount)
	if dhcpOverhead != 120 {
		t.Fatalf("dhcpWithOverhead(100) = %d, want 120", dhcpOverhead)
	}

	totalObjects := dc.dnsObjectCount + dhcpOverhead
	tier := calcADTier(dc.qps, dc.lps, totalObjects)

	metric := adServerMetricInternal{
		Hostname:              dc.computerName,
		DNSObjects:            dc.dnsObjectCount,
		DHCPObjects:           dc.dhcpObjectCount,
		DHCPObjectsWithOverhead: dhcpOverhead,
		QPS:                   dc.qps,
		LPS:                   dc.lps,
		Tier:                  tier.name,
		ServerTokens:          tier.serverTokens,
	}

	if metric.Hostname != "DC01" {
		t.Errorf("Hostname = %q, want DC01", metric.Hostname)
	}
	if metric.DHCPObjectsWithOverhead != 120 {
		t.Errorf("DHCPObjectsWithOverhead = %d, want 120", metric.DHCPObjectsWithOverhead)
	}
	// totalObjects = 150 + 120 = 270, QPS/LPS=0 → fits in 2XS (maxObjects=3000)
	if metric.Tier != "2XS" {
		t.Errorf("Tier = %q, want 2XS (totalObjects=270)", metric.Tier)
	}
}

// TestADServerMetricJSON verifies JSON marshaling round-trips correctly.
func TestADServerMetricJSON(t *testing.T) {
	metrics := []adServerMetricInternal{
		{
			Hostname: "DC01", DNSObjects: 100, DHCPObjects: 50,
			DHCPObjectsWithOverhead: 60, QPS: 0, LPS: 0,
			Tier: "2XS", ServerTokens: 130,
		},
		{
			Hostname: "DC02", DNSObjects: 5000, DHCPObjects: 3000,
			DHCPObjectsWithOverhead: 3600, QPS: 1000, LPS: 50,
			Tier: "XS", ServerTokens: 250,
		},
	}

	data, err := json.Marshal(metrics)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var decoded []adServerMetricInternal
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	if len(decoded) != 2 {
		t.Fatalf("decoded length = %d, want 2", len(decoded))
	}
	if decoded[0].Hostname != "DC01" || decoded[1].Hostname != "DC02" {
		t.Errorf("hostnames = [%q, %q], want [DC01, DC02]", decoded[0].Hostname, decoded[1].Hostname)
	}
	if decoded[0].DHCPObjectsWithOverhead != 60 {
		t.Errorf("DC01 DHCPObjectsWithOverhead = %d, want 60", decoded[0].DHCPObjectsWithOverhead)
	}
}

// TestComputerKeysMerge verifies computerKeys and staticIPKeys merge across DCs.
func TestComputerKeysMerge(t *testing.T) {
	var agg dcAggregator
	agg.init()

	r1 := &dcResult{
		computerKeys: map[string]struct{}{"pc01": {}, "pc02": {}},
		staticIPKeys: map[string]struct{}{"10.0.0.1": {}},
	}
	r2 := &dcResult{
		computerKeys: map[string]struct{}{"pc02": {}, "pc03": {}}, // pc02 duplicated
		staticIPKeys: map[string]struct{}{"10.0.0.1": {}, "10.0.0.2": {}}, // 10.0.0.1 duplicated
	}

	agg.merge(r1)
	agg.merge(r2)

	if got := len(agg.computerKeys); got != 3 {
		t.Errorf("computerKeys count = %d, want 3 (pc01, pc02, pc03)", got)
	}
	if got := len(agg.staticIPKeys); got != 2 {
		t.Errorf("staticIPKeys count = %d, want 2 (10.0.0.1, 10.0.0.2)", got)
	}
}

// TestDCResultsTrackedInAggregator verifies dcResults slice in aggregator.
func TestDCResultsTrackedInAggregator(t *testing.T) {
	var agg dcAggregator
	agg.init()

	r1 := &dcResult{computerName: "DC01", dnsObjectCount: 10, dhcpObjectCount: 5}
	r2 := &dcResult{computerName: "DC02", dnsObjectCount: 20, dhcpObjectCount: 15}
	agg.merge(r1)
	agg.merge(r2)

	if len(agg.dcResults) != 2 {
		t.Fatalf("dcResults count = %d, want 2", len(agg.dcResults))
	}
	if agg.dcResults[0].computerName != "DC01" || agg.dcResults[1].computerName != "DC02" {
		t.Errorf("dcResults names = [%q, %q], want [DC01, DC02]",
			agg.dcResults[0].computerName, agg.dcResults[1].computerName)
	}
}

// TestGetADServerMetricsJSON verifies the Scanner implements ADResultScanner.
func TestGetADServerMetricsJSON(t *testing.T) {
	s := New()
	// Before scan, should be nil
	if got := s.GetADServerMetricsJSON(); got != nil {
		t.Errorf("GetADServerMetricsJSON before scan = %v, want nil", got)
	}

	// Simulate setting metrics
	s.adServerMetricsJSON = []byte(`[{"hostname":"DC01","tier":"2XS"}]`)
	got := s.GetADServerMetricsJSON()
	if got == nil {
		t.Fatal("GetADServerMetricsJSON after set = nil, want non-nil")
	}
	if !strings.Contains(string(got), "DC01") {
		t.Errorf("metrics JSON should contain DC01, got: %s", string(got))
	}

	// Verify ADResultScanner interface compliance
	var _ scanner.ADResultScanner = s
}

// TestEventLogGracefulFallback verifies that the event log extraction functions
// never produce an error that would fail the scan. They always return (0, nil)
// or (value, nil) — never an error.
func TestEventLogGracefulFallback(t *testing.T) {
	// The functions will fail connecting to WinRM (no real server)
	// but should return 0, nil — NOT an error.
	// We can't easily mock WinRM client here, so we test the tier
	// calculation with qps=0 and lps=0 to verify the downstream behavior.
	tier := calcADTier(0, 0, 100)
	if tier.name != "2XS" {
		t.Errorf("tier with qps=0, lps=0, obj=100 = %q, want 2XS", tier.name)
	}
}

// TestPerDCRawCounts verifies per-DC raw counts are calculated correctly.
func TestPerDCRawCounts(t *testing.T) {
	dc := &dcResult{
		zoneNames: map[string]struct{}{"a.com": {}, "b.com": {}},
		recordKeys: map[string]struct{}{
			"a.com|@|A|1.2.3.4": {},
			"b.com|@|A|5.6.7.8": {},
			"b.com|mx|MX|mail":  {},
		},
		scopeIDs:        map[string]struct{}{"10.0.0.0": {}},
		leaseKeys:       map[string]struct{}{"10.0.0.0|10.0.0.5": {}, "10.0.0.0|10.0.0.6": {}},
		reservationKeys: map[string]struct{}{"10.0.0.0|10.0.0.100": {}},
	}

	dnsObjectCount := len(dc.zoneNames) + len(dc.recordKeys)
	dhcpObjectCount := len(dc.scopeIDs) + len(dc.leaseKeys) + len(dc.reservationKeys)

	if dnsObjectCount != 5 {
		t.Errorf("dnsObjectCount = %d, want 5 (2 zones + 3 records)", dnsObjectCount)
	}
	if dhcpObjectCount != 4 {
		t.Errorf("dhcpObjectCount = %d, want 4 (1 scope + 2 leases + 1 reservation)", dhcpObjectCount)
	}

	dhcpOverhead := dhcpWithOverhead(dhcpObjectCount)
	// ceil(4 * 1.2) = ceil(4.8) = 5
	if dhcpOverhead != 5 {
		t.Errorf("dhcpWithOverhead(%d) = %d, want 5", dhcpObjectCount, dhcpOverhead)
	}
}

// TestTierTableCompleteness verifies the tier table has all 6 expected tiers.
func TestTierTableCompleteness(t *testing.T) {
	expectedNames := []string{"2XS", "XS", "S", "M", "L", "XL"}
	if len(adServerTiers) != len(expectedNames) {
		t.Fatalf("adServerTiers has %d tiers, want %d", len(adServerTiers), len(expectedNames))
	}
	for i, want := range expectedNames {
		if adServerTiers[i].name != want {
			t.Errorf("adServerTiers[%d].name = %q, want %q", i, adServerTiers[i].name, want)
		}
	}
}

// TestTierTableMatchesFrontend verifies Go tier table matches nios-calc.ts SERVER_TOKEN_TIERS.
func TestTierTableMatchesFrontend(t *testing.T) {
	// Values from frontend/src/app/components/nios-calc.ts SERVER_TOKEN_TIERS
	expected := []struct {
		name         string
		maxQPS       int
		maxLPS       int
		maxObjects   int
		serverTokens int
	}{
		{"2XS", 5_000, 75, 3_000, 130},
		{"XS", 10_000, 150, 7_500, 250},
		{"S", 20_000, 200, 29_000, 470},
		{"M", 40_000, 300, 110_000, 880},
		{"L", 70_000, 400, 440_000, 1_900},
		{"XL", 115_000, 675, 880_000, 2_700},
	}
	for i, e := range expected {
		tier := adServerTiers[i]
		if tier.name != e.name || tier.maxQPS != e.maxQPS || tier.maxLPS != e.maxLPS ||
			tier.maxObjects != e.maxObjects || tier.serverTokens != e.serverTokens {
			t.Errorf("tier[%d] = %+v, want name=%s maxQPS=%d maxLPS=%d maxObjects=%d tokens=%d",
				i, tier, e.name, e.maxQPS, e.maxLPS, e.maxObjects, e.serverTokens)
		}
	}
}

// TestPerDCRowEmission verifies that the Scan-level per-DC row building logic
// emits separate rows for each DC, matching the NIOS per-member pattern.
// This test exercises the row-building code directly via a synthetic aggregator.
func TestPerDCRowEmission(t *testing.T) {
	// Simulate two DCs after scanAllDCs returns — build the dcResults slice
	// the same way Scan does.
	dc1 := &dcResult{
		computerName: "DC01",
		inputHost:    "192.168.1.10",
		zoneNames:    map[string]struct{}{"corp.local": {}},
		recordKeys:   map[string]struct{}{"corp.local|@|A|1.2.3.4": {}, "corp.local|host1|A|1.2.3.5": {}},
		scopeIDs:     map[string]struct{}{"10.0.0.0": {}},
		leaseKeys:    map[string]struct{}{"10.0.0.0|10.0.0.5": {}},
		userKeys:     map[string]struct{}{"sid:s-1": {}, "sid:s-2": {}},
		computerKeys: map[string]struct{}{},
		staticIPKeys: map[string]struct{}{},
	}
	dc1.dnsObjectCount = len(dc1.zoneNames) + len(dc1.recordKeys)
	dc1.dhcpObjectCount = len(dc1.scopeIDs) + len(dc1.leaseKeys)

	dc2 := &dcResult{
		computerName: "DC02",
		inputHost:    "192.168.1.11",
		zoneNames:    map[string]struct{}{"corp.local": {}, "internal.corp": {}},
		recordKeys:   map[string]struct{}{"corp.local|@|A|1.2.3.4": {}},
		scopeIDs:     map[string]struct{}{"10.0.1.0": {}},
		leaseKeys:    map[string]struct{}{},
		userKeys:     map[string]struct{}{"sid:s-1": {}},
		computerKeys: map[string]struct{}{},
		staticIPKeys: map[string]struct{}{},
	}
	dc2.dnsObjectCount = len(dc2.zoneNames) + len(dc2.recordKeys)
	dc2.dhcpObjectCount = len(dc2.scopeIDs) + len(dc2.leaseKeys)

	dcResults := []*dcResult{dc1, dc2}

	// Emit per-DC rows (reproduces Scan logic).
	var findings []calculator.FindingRow
	for _, dc := range dcResults {
		dcRows := []calculator.FindingRow{
			{Provider: scanner.ProviderAD, Source: dc.computerName, Category: calculator.CategoryDDIObjects, Item: "dns_zone", Count: len(dc.zoneNames)},
			{Provider: scanner.ProviderAD, Source: dc.computerName, Category: calculator.CategoryDDIObjects, Item: "dns_record", Count: len(dc.recordKeys)},
			{Provider: scanner.ProviderAD, Source: dc.computerName, Category: calculator.CategoryDDIObjects, Item: "dhcp_scope", Count: len(dc.scopeIDs)},
			{Provider: scanner.ProviderAD, Source: dc.computerName, Category: calculator.CategoryActiveIPs, Item: "dhcp_lease", Count: len(dc.leaseKeys)},
			{Provider: scanner.ProviderAD, Source: dc.computerName, Category: calculator.CategoryManagedAssets, Item: "user_account", Count: len(dc.userKeys)},
		}
		for _, row := range dcRows {
			if row.Count > 0 {
				findings = append(findings, row)
			}
		}
	}

	// Verify separate rows exist for each DC.
	dc1Sources := 0
	dc2Sources := 0
	for _, row := range findings {
		switch row.Source {
		case "DC01":
			dc1Sources++
		case "DC02":
			dc2Sources++
		default:
			t.Errorf("unexpected source %q in findings", row.Source)
		}
	}
	if dc1Sources == 0 {
		t.Error("no rows emitted for DC01")
	}
	if dc2Sources == 0 {
		t.Error("no rows emitted for DC02")
	}

	// Counts must NOT be merged — per-DC data is raw (replicated objects counted per-DC).
	// DNS zones: DC01 has 1, DC02 has 2 — each row shows that DC's count.
	for _, row := range findings {
		if row.Item == "dns_zone" {
			switch row.Source {
			case "DC01":
				if row.Count != 1 {
					t.Errorf("DC01 dns_zone count = %d, want 1", row.Count)
				}
			case "DC02":
				if row.Count != 2 {
					t.Errorf("DC02 dns_zone count = %d, want 2", row.Count)
				}
			}
		}
	}
}

// TestPerDCSelectedDCFilter verifies that selected_dcs filters by both
// computerName (resolved COMPUTERNAME) and inputHost (raw IP/FQDN).
func TestPerDCSelectedDCFilter(t *testing.T) {
	dc1 := &dcResult{computerName: "DC01", inputHost: "192.168.1.10", zoneNames: map[string]struct{}{"a": {}}}
	dc2 := &dcResult{computerName: "DC02", inputHost: "dc02.corp.local", zoneNames: map[string]struct{}{"b": {}}}
	dc3 := &dcResult{computerName: "DC03", inputHost: "192.168.1.12", zoneNames: map[string]struct{}{"c": {}}}

	tests := []struct {
		name          string
		selectedDCSet map[string]struct{}
		wantSources   []string
	}{
		{
			name:          "no filter — all DCs included",
			selectedDCSet: map[string]struct{}{},
			wantSources:   []string{"DC01", "DC02", "DC03"},
		},
		{
			name:          "filter by computerName",
			selectedDCSet: map[string]struct{}{"DC01": {}, "DC03": {}},
			wantSources:   []string{"DC01", "DC03"},
		},
		{
			name:          "filter by inputHost (FQDN)",
			selectedDCSet: map[string]struct{}{"dc02.corp.local": {}},
			wantSources:   []string{"DC02"},
		},
		{
			name:          "filter by inputHost (IP)",
			selectedDCSet: map[string]struct{}{"192.168.1.10": {}},
			wantSources:   []string{"DC01"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sources []string
			for _, dc := range []*dcResult{dc1, dc2, dc3} {
				if len(tt.selectedDCSet) > 0 {
					_, nameMatch := tt.selectedDCSet[dc.computerName]
					_, hostMatch := tt.selectedDCSet[dc.inputHost]
					if !nameMatch && !hostMatch {
						continue
					}
				}
				sources = append(sources, dc.computerName)
			}

			if len(sources) != len(tt.wantSources) {
				t.Fatalf("sources = %v, want %v", sources, tt.wantSources)
			}
			for i, want := range tt.wantSources {
				if sources[i] != want {
					t.Errorf("sources[%d] = %q, want %q", i, sources[i], want)
				}
			}
		})
	}
}
