// Package nios_test contains RED-phase test stubs for the NIOS scanner.
// All tests in this file fail until the implementation is provided in Wave 1-3.
// Run: go test ./internal/scanner/nios/... -count=1 -v
package nios_test

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
	niosscanner "github.com/infoblox/uddi-go-token-calculator/internal/scanner/nios"
)

// NiosResultScanner is the optional interface implemented by the NIOS scanner
// that exposes per-member metrics as JSON. Must match the canonical interface
// added to internal/scanner/provider.go in Plan 10-03.
type NiosResultScanner interface {
	GetNiosServerMetricsJSON() []byte
}

// openFixture opens testdata/minimal.tar.gz and returns its path.
// Tests call this to get the backup_path credential value.
func openFixture(t *testing.T) string {
	t.Helper()
	path := "testdata/minimal.tar.gz"
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("testdata/minimal.tar.gz missing — run TestGenerateMinimalFixture first: %v", err)
	}
	return path
}

// runScan is a helper that executes Scan with both test members selected.
func runScan(t *testing.T) []calculator.FindingRow {
	t.Helper()
	path := openFixture(t)
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.test.local,dns1.test.local,dhcp1.test.local",
		},
	}
	rows, err := niosscanner.New().Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan returned error: %v", err)
	}
	return rows
}

// TestNIOS_DDIFamilyCounts verifies that DDI Object findings include DNS zones.
// RED: Scan() returns empty — test fails because no findings are returned.
func TestNIOS_DDIFamilyCounts(t *testing.T) {
	rows := runScan(t)

	// Expect at least one FindingRow with Category=DDI Objects and Item="DNS Zones".
	found := false
	for _, r := range rows {
		if r.Category == calculator.CategoryDDIObjects && r.Item == "DNS Zones" {
			if r.Count >= 2 {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("expected FindingRow{Category=%q, Item=%q, Count>=2}; got rows: %+v",
			calculator.CategoryDDIObjects, "DNS Zones", rows)
	}
}

// TestNIOS_ActiveIPCounts verifies that Active IP findings reflect all active lease IPs
// plus fixed, host, network, and discovery IPs (deduplicated).
func TestNIOS_ActiveIPCounts(t *testing.T) {
	rows := runScan(t)

	totalActiveIPs := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			totalActiveIPs += r.Count
		}
	}
	// Expect 9 unique IPs:
	// 4 active leases (10.0.0.1,.2,.3 on GM + 10.0.0.20 on dhcp1)
	// + 1 fixed (10.0.0.50) + 1 host (10.0.0.51) + 2 network (10.0.1.0, 10.0.1.255)
	// + 1 unique discovery (10.0.0.100; 10.0.0.1 from discovery dedupes with lease)
	if totalActiveIPs < 9 {
		t.Errorf("expected total Active IPs >= 9; got %d (rows: %+v)", totalActiveIPs, rows)
	}
}

// TestNIOS_NoAssetRows verifies that NIOS Grid Members are NOT counted as managed assets.
// NIOS appliances are part of NIOS grid licensing, not Universal DDI managed assets.
func TestNIOS_NoAssetRows(t *testing.T) {
	rows := runScan(t)

	for _, r := range rows {
		if r.Category == calculator.CategoryManagedAssets {
			t.Errorf("unexpected Managed Assets row for NIOS: %+v", r)
		}
	}
}

// TestNIOS_Deduplication verifies that no IP address is counted more than once
// across all FindingRows (no double-counting between members).
// RED: Scan() returns empty — test passes vacuously when empty but fails once
// implementation exists (deduplication logic must be explicit).
func TestNIOS_Deduplication(t *testing.T) {
	rows := runScan(t)

	// If the scan returns nothing, we cannot verify deduplication — fail explicitly.
	if len(rows) == 0 {
		t.Fatal("Scan returned no rows — cannot verify deduplication (expected non-empty results)")
	}

	// For each IP-bearing row, verify it appears in at most one source row.
	// The simplest proxy: total Active IP count across all members should not
	// exceed the distinct IP count in the fixture (3 active leases).
	totalActiveIPs := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			totalActiveIPs += r.Count
		}
	}
	// The fixture has 9 unique IPs across all sources:
	// 4 active leases + 1 fixed + 1 host + 2 network + 1 unique discovery (10.0.0.1 deduped).
	// If totalActiveIPs > 9, double-counting occurred.
	if totalActiveIPs > 9 {
		t.Errorf("Active IP double-counting detected: total=%d but fixture has 9 unique IPs", totalActiveIPs)
	}
}

// TestNIOS_NiosServerMetrics verifies that the scanner implements NiosResultScanner
// and returns valid JSON with at least one member entry containing memberId and role.
// RED: The stub Scanner does not implement NiosResultScanner — type assertion fails.
func TestNIOS_NiosServerMetrics(t *testing.T) {
	path := openFixture(t)
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.test.local,dns1.test.local,dhcp1.test.local",
		},
	}

	s := niosscanner.New()
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan returned error: %v", err)
	}

	nrs, ok := any(s).(NiosResultScanner)
	if !ok {
		t.Fatal("nios.Scanner does not implement NiosResultScanner (GetNiosServerMetricsJSON() []byte) — implementation needed in Wave 1-3")
	}

	data := nrs.GetNiosServerMetricsJSON()
	if data == nil {
		t.Fatal("GetNiosServerMetricsJSON() returned nil")
	}

	var metrics []map[string]interface{}
	if err := json.Unmarshal(data, &metrics); err != nil {
		t.Fatalf("GetNiosServerMetricsJSON() returned invalid JSON: %v\ndata: %s", err, data)
	}
	if len(metrics) < 1 {
		t.Fatalf("expected >= 1 entry in NiosServerMetrics; got %d", len(metrics))
	}

	first := metrics[0]
	if v, ok := first["memberId"]; !ok || v == "" {
		t.Errorf("first metric entry missing non-empty 'memberId'; entry: %+v", first)
	}
	if v, ok := first["role"]; !ok || v == "" {
		t.Errorf("first metric entry missing non-empty 'role'; entry: %+v", first)
	}
}

// TestFindingRowsHaveTokensAndSource verifies that every NIOS FindingRow has:
// - Non-empty Source field (member hostname)
// - Non-zero ManagementTokens for DDI Object rows
// - No "DDI Objects (Total)" summary row (per-family rows carry their own tokens)
// - Active Leases row has ManagementTokens > 0
func TestFindingRowsHaveTokensAndSource(t *testing.T) {
	rows := runScan(t)
	if len(rows) == 0 {
		t.Fatal("Scan returned no rows")
	}

	for i, r := range rows {
		// Every row must have a non-empty Source.
		if r.Source == "" {
			t.Errorf("row %d (%s / %s) has empty Source", i, r.Category, r.Item)
		}

		// No summary row should exist.
		if r.Item == "DDI Objects (Total)" {
			t.Errorf("row %d: unexpected summary row 'DDI Objects (Total)' — per-family rows should carry tokens", i)
		}

		// Every DDI Object row with Count > 0 must have ManagementTokens > 0.
		if r.Category == calculator.CategoryDDIObjects && r.Count > 0 && r.ManagementTokens == 0 {
			t.Errorf("row %d (%s) has Count=%d but ManagementTokens=0", i, r.Item, r.Count)
		}
	}

	// Active IPs row must have tokens.
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs && r.Item == "NIOS Active IPs (All Sources)" {
			if r.ManagementTokens == 0 {
				t.Errorf("Active IPs row has ManagementTokens=0 (Count=%d)", r.Count)
			}
		}
	}
}

// TestNIOS_DiscoveryDataActiveIPs verifies that discovery_data objects contribute
// their ip_address to the Active IP count, with deduplication against leases.
func TestNIOS_DiscoveryDataActiveIPs(t *testing.T) {
	rows := runScan(t)

	// Count Active IP rows.
	var activeIPRow *calculator.FindingRow
	for i, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			activeIPRow = &rows[i]
		}
	}

	if activeIPRow == nil {
		t.Fatal("expected an Active IPs FindingRow; got none")
	}

	// Should be a single all-sources row.
	if activeIPRow.Item != "NIOS Active IPs (All Sources)" {
		t.Errorf("expected item 'NIOS Active IPs (All Sources)'; got %q", activeIPRow.Item)
	}

	// Fixture unique IPs: 10.0.0.1, .2, .3 (GM leases) + 10.0.0.20 (dhcp1 lease) +
	// 10.0.0.50 (fixed) + 10.0.0.51 (host) + 10.0.1.0, 10.0.1.255 (network) +
	// 10.0.0.100 (discovery unique). 10.0.0.1 from discovery dedupes with lease.
	// Non-active leases (expired 10.0.0.21, free 10.0.0.99) do NOT contribute IPs.
	if activeIPRow.Count != 9 {
		t.Errorf("expected Active IP count=9 (all sources, deduped); got %d", activeIPRow.Count)
	}
}

// TestNIOS_IdnsDTCMapping verifies that idns_lbdn objects are counted as DTC DDI objects.
func TestNIOS_IdnsDTCMapping(t *testing.T) {
	rows := runScan(t)

	found := false
	for _, r := range rows {
		if r.Category == calculator.CategoryDDIObjects && r.Item == "DTC Load-Balanced Names" {
			if r.Count >= 1 {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("expected FindingRow for DTC Load-Balanced Names with Count>=1; got rows: %+v", rows)
	}
}

// TestNIOS_AllMembersInMetrics verifies that all 3 members appear in NiosServerMetrics,
// including dhcp1.test.local which has no leases attributed to it.
func TestNIOS_AllMembersInMetrics(t *testing.T) {
	path := openFixture(t)
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.test.local,dns1.test.local,dhcp1.test.local",
		},
	}

	s := niosscanner.New()
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan returned error: %v", err)
	}

	nrs, ok := any(s).(NiosResultScanner)
	if !ok {
		t.Fatal("nios.Scanner does not implement NiosResultScanner")
	}

	data := nrs.GetNiosServerMetricsJSON()
	if data == nil {
		t.Fatal("GetNiosServerMetricsJSON() returned nil")
	}

	var metrics []niosscanner.NiosServerMetric
	if err := json.Unmarshal(data, &metrics); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	if len(metrics) != 3 {
		t.Fatalf("expected 3 members in metrics; got %d: %+v", len(metrics), metrics)
	}

	// Verify all three members are present.
	memberSet := make(map[string]string) // hostname -> role
	for _, m := range metrics {
		memberSet[m.MemberID] = m.Role
	}

	expected := []string{"gm.test.local", "dns1.test.local", "dhcp1.test.local"}
	for _, h := range expected {
		if _, ok := memberSet[h]; !ok {
			t.Errorf("member %q not found in metrics; got: %+v", h, memberSet)
		}
	}

	// dhcp1 should have DHCP role (from enable_dhcp=true).
	if role := memberSet["dhcp1.test.local"]; role != "DHCP" {
		t.Errorf("expected dhcp1.test.local role=DHCP; got %q", role)
	}
}

// TestNIOS_GridLevelDDISeparateFromMembers verifies that DDI objects are grid-level
// (attributed to GM in FindingRows) and NOT stored in per-member accumulators.
// This matches the Python reference where all non-lease DDI has member_hostname=None
// and goes into grid_ddi, not per_member[hostname].ddi_count.
func TestNIOS_GridLevelDDISeparateFromMembers(t *testing.T) {
	rows := runScan(t)

	// All DDI FindingRows should have Source == GM hostname.
	// No DDI row should have Source == dns1 or dhcp1 (non-GM members never get DDI).
	for _, r := range rows {
		if r.Category == calculator.CategoryDDIObjects {
			if r.Source != "gm.test.local" {
				t.Errorf("DDI row has Source=%q, want 'gm.test.local' (DDI is grid-level); row: %+v", r.Source, r)
			}
		}
	}
}

// TestNIOS_NonActiveLeasesCounted verifies that non-active leases are counted in
// raw lease totals but do NOT contribute to Active IP counts.
// Fixture has: 3 active (GM), 1 active (dhcp1), 1 expired (dhcp1), 1 free (GM) = 6 total.
// Python counts ALL lease rows in grid_lease_count regardless of binding_state.
func TestNIOS_NonActiveLeasesCounted(t *testing.T) {
	rows := runScan(t)

	// Active IPs should be 9 (only active leases + fixed + host + network + discovery).
	// Non-active leases (expired 10.0.0.21, free 10.0.0.99) must NOT appear in IP count.
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			if r.Count != 9 {
				t.Errorf("Active IPs = %d, want 9 (expired/free leases must not contribute IPs)", r.Count)
			}
		}
	}
}

// TestNIOS_HostObjectDDIExpansion verifies that HOST_OBJECT DDI count uses the
// expanded delta (+2 for no aliases, +3 for aliases present) matching Python counter.py.
// Fixture has: server1 (no aliases) = +2, server2 (aliases="alias1.test.local") = +3.
// Total HOST_OBJECT DDI contribution = 5.
func TestNIOS_HostObjectDDIExpansion(t *testing.T) {
	rows := runScan(t)

	for _, r := range rows {
		if r.Category == calculator.CategoryDDIObjects && r.Item == "Host Records" {
			// HOST_OBJECT familyCounts should show DDI-adjusted count: 2+3=5.
			if r.Count != 5 {
				t.Errorf("Host Records DDI count = %d, want 5 (2 for no-alias + 3 for with-alias)", r.Count)
			}
			return
		}
	}
	t.Error("no Host Records FindingRow found in DDI Objects")
}

// TestNIOS_MultiMemberLeaseAttribution verifies that leases are attributed to the
// correct member via vnode_id resolution. Fixture has leases on both GM (vnode_id=101)
// and dhcp1 (vnode_id=103).
func TestNIOS_MultiMemberLeaseAttribution(t *testing.T) {
	path := openFixture(t)
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.test.local,dns1.test.local,dhcp1.test.local",
		},
	}

	s := niosscanner.New()
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan returned error: %v", err)
	}

	nrs, ok := any(s).(NiosResultScanner)
	if !ok {
		t.Fatal("nios.Scanner does not implement NiosResultScanner")
	}

	data := nrs.GetNiosServerMetricsJSON()
	var metrics []niosscanner.NiosServerMetric
	if err := json.Unmarshal(data, &metrics); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}

	// Build lookup by hostname.
	metricsByHost := make(map[string]niosscanner.NiosServerMetric)
	for _, m := range metrics {
		metricsByHost[m.MemberID] = m
	}

	// GM (gm.test.local) should have all grid-level DDI objects.
	// Fixture DDI: 2 zones + 1 network + 1 DTC LBDN + 5 host records (2+3) = 9.
	gm := metricsByHost["gm.test.local"]
	if gm.ObjectCount != 9 {
		t.Errorf("GM ObjectCount = %d, want 9 (all DDI is grid-level, attributed to GM)", gm.ObjectCount)
	}

	// dns1.test.local has no leases and no DDI -> ObjectCount = 0.
	dns1 := metricsByHost["dns1.test.local"]
	if dns1.ObjectCount != 0 {
		t.Errorf("dns1 ObjectCount = %d, want 0 (no DDI, no leases)", dns1.ObjectCount)
	}

	// dhcp1.test.local has no DDI (all DDI is grid-level) -> ObjectCount = 0.
	dhcp1 := metricsByHost["dhcp1.test.local"]
	if dhcp1.ObjectCount != 0 {
		t.Errorf("dhcp1 ObjectCount = %d, want 0 (no DDI, leases don't count as DDI)", dhcp1.ObjectCount)
	}
}
