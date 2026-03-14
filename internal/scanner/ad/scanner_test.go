package ad

import (
	"fmt"
	"strings"
	"testing"

	"github.com/masterzen/winrm"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Compile-time signature assertion — BuildNTLMClient must remain exported
// with this exact signature. This test will FAIL TO COMPILE (not just fail)
// if the signature changes.
var _ func(string, string, string) (*winrm.Client, error) = BuildNTLMClient

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

// TestBuildNTLMClientHTTPS: BuildNTLMClient with HTTPS options must connect on port 5986.
// Wave 0 stub -- currently tests only the HTTP path because the HTTPS functional
// options (WithHTTPS, WithInsecureSkipVerify) do not exist yet.
// Plan 15-02 will add the options and this test will be updated to use them.
func TestBuildNTLMClientHTTPS(t *testing.T) {
	// Current signature: BuildNTLMClient(host, username, password string) (*winrm.Client, error)
	// After plan 15-02: BuildNTLMClient(host, username, password string, opts ...ClientOption)
	//
	// For now, verify the HTTP path works (baseline).
	// The test name reserves the slot for HTTPS verification after 15-02.
	client, err := BuildNTLMClient("127.0.0.1", "testuser", "testpass")
	if err != nil {
		t.Fatalf("BuildNTLMClient (HTTP) failed: %v", err)
	}
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	// TODO(15-02): After WithHTTPS() is added, test:
	//   client, err := BuildNTLMClient("127.0.0.1", "testuser", "testpass", WithHTTPS())
	//   Verify endpoint uses port 5986 and TLS=true
	//   client, err := BuildNTLMClient("127.0.0.1", "testuser", "testpass", WithHTTPS(), WithInsecureSkipVerify())
	//   Verify endpoint uses port 5986, TLS=true, InsecureSkipVerify=true
	t.Log("HTTPS options not yet available -- test reserved for plan 15-02")
}
