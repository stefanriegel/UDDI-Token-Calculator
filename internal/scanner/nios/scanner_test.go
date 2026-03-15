// Package nios_test contains RED-phase test stubs for the NIOS scanner.
// All tests in this file fail until the implementation is provided in Wave 1-3.
// Run: go test ./internal/scanner/nios/... -count=1 -v
package nios_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
// plus fixed, host, network, and discovery IPs (deduplicated per-member).
func TestNIOS_ActiveIPCounts(t *testing.T) {
	rows := runScan(t)

	totalActiveIPs := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			totalActiveIPs += r.Count
		}
	}
	// Expect 11 unique IPs across per-member rows:
	// GM (owns 10.0.0.0/24): 3 leases + fixed + host + discovery + 2 network IPs = 8
	// dhcp1 (owns 10.0.1.0/24): 1 lease (vnode) + 2 network IPs = 3
	// Total = 11 (no overlap between member sets since IPs fall in different subnets)
	if totalActiveIPs != 11 {
		t.Errorf("expected total Active IPs = 11; got %d (rows: %+v)", totalActiveIPs, rows)
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
	// The fixture has 11 unique IPs across all sources (with 2 networks):
	// 4 active leases + 1 fixed + 1 host + 4 network IPs (2 networks) + 1 unique discovery.
	// Per-member sets don't overlap (different subnets), so sum should equal 11.
	// If totalActiveIPs > 11, double-counting occurred.
	if totalActiveIPs > 11 {
		t.Errorf("Active IP double-counting detected: total=%d but fixture has 11 unique IPs", totalActiveIPs)
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

	// Active IPs rows must have tokens.
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs && r.Item == "Active IPs" {
			if r.ManagementTokens == 0 {
				t.Errorf("Active IPs row for %s has ManagementTokens=0 (Count=%d)", r.Source, r.Count)
			}
		}
	}
}

// TestNIOS_DiscoveryDataActiveIPs verifies that discovery_data objects contribute
// their ip_address to the Active IP count, with deduplication against leases.
// Discovery IP 10.0.0.100 should be attributed to gm.test.local (its containing
// subnet 10.0.0.0/24 is owned by GM via dhcp_member).
func TestNIOS_DiscoveryDataActiveIPs(t *testing.T) {
	rows := runScan(t)

	// Should have per-member Active IP rows, not a single grid-level row.
	activeIPRows := 0
	totalActiveIPs := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			activeIPRows++
			totalActiveIPs += r.Count
			// Each Active IP row should have item "Active IPs" (per-member).
			if r.Item != "Active IPs" {
				t.Errorf("expected per-member item 'Active IPs'; got %q", r.Item)
			}
		}
	}

	if activeIPRows == 0 {
		t.Fatal("expected Active IPs FindingRows; got none")
	}

	// Fixture unique IPs: 10.0.0.1, .2, .3 (GM leases) + 10.0.0.20 (dhcp1 lease) +
	// 10.0.0.50 (fixed) + 10.0.0.51 (host) + 10.0.0.0, 10.0.0.255 (network 10.0.0.0/24) +
	// 10.0.1.0, 10.0.1.255 (network 10.0.1.0/24) + 10.0.0.100 (discovery unique).
	// 10.0.0.1 from discovery dedupes with lease within GM's memberIPSet.
	// Non-active leases (expired 10.0.0.21, free 10.0.0.99) do NOT contribute IPs.
	if totalActiveIPs != 11 {
		t.Errorf("expected total Active IPs = 11 (all sources, deduped per-member); got %d", totalActiveIPs)
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

// TestNIOS_GridLevelDDISeparateFromMembers verifies that DDI objects are attributed
// to the correct member via memberResolver. Networks with dhcp_member mappings go
// to the mapped member; DNS zones go to their ns_group member; unresolved DDI falls
// back to GM.
func TestNIOS_GridLevelDDISeparateFromMembers(t *testing.T) {
	rows := runScan(t)

	// DDI FindingRows should have Source matching the resolved member.
	// With dhcp_member mappings: 10.0.0.0/24 → GM, 10.0.1.0/24 → dhcp1.
	// Zones and other DDI without resolution fall back to GM.
	ddiBySource := make(map[string]int)
	for _, r := range rows {
		if r.Category == calculator.CategoryDDIObjects {
			ddiBySource[r.Source] += r.Count
		}
	}

	// GM should have most DDI (zones, host records, DTC, network 10.0.0.0/24).
	if gmDDI := ddiBySource["gm.test.local"]; gmDDI < 8 {
		t.Errorf("GM DDI count = %d, want >= 8 (zones+hosts+DTC+network)", gmDDI)
	}

	// dhcp1 should have 1 DDI (network 10.0.1.0/24 via dhcp_member mapping).
	if dhcp1DDI := ddiBySource["dhcp1.test.local"]; dhcp1DDI != 1 {
		t.Errorf("dhcp1 DDI count = %d, want 1 (network 10.0.1.0/24 via dhcp_member)", dhcp1DDI)
	}

	// dns1 should have no DDI.
	if dns1DDI := ddiBySource["dns1.test.local"]; dns1DDI != 0 {
		t.Errorf("dns1 DDI count = %d, want 0", dns1DDI)
	}
}

// TestNIOS_NonActiveLeasesCounted verifies that non-active leases are counted in
// raw lease totals but do NOT contribute to Active IP counts.
// Fixture has: 3 active (GM), 1 active (dhcp1), 1 expired (dhcp1), 1 free (GM) = 6 total.
// Python counts ALL lease rows in grid_lease_count regardless of binding_state.
func TestNIOS_NonActiveLeasesCounted(t *testing.T) {
	rows := runScan(t)

	// Sum Active IPs across per-member rows.
	// Should be 11 (only active leases + fixed + host + 2x network + discovery).
	// Non-active leases (expired 10.0.0.21, free 10.0.0.99) must NOT appear in IP count.
	totalActiveIPs := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			totalActiveIPs += r.Count
		}
	}
	if totalActiveIPs != 11 {
		t.Errorf("total Active IPs = %d, want 11 (expired/free leases must not contribute IPs)", totalActiveIPs)
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

	// GM (gm.test.local) should have grid-level DDI + network 10.0.0.0/24.
	// Fixture DDI: 2 zones + 1 network (10.0.0.0/24→GM) + 1 DTC LBDN + 5 host records (2+3) = 9.
	// Plus unresolved DDI falls back to GM.
	gm := metricsByHost["gm.test.local"]
	if gm.ObjectCount != 9 {
		t.Errorf("GM ObjectCount = %d, want 9 (zones+1 network+DTC+hosts)", gm.ObjectCount)
	}

	// dns1.test.local has no leases and no DDI -> ObjectCount = 0.
	dns1 := metricsByHost["dns1.test.local"]
	if dns1.ObjectCount != 0 {
		t.Errorf("dns1 ObjectCount = %d, want 0 (no DDI, no leases)", dns1.ObjectCount)
	}

	// dhcp1.test.local has 1 DDI (network 10.0.1.0/24 via dhcp_member mapping).
	dhcp1 := metricsByHost["dhcp1.test.local"]
	if dhcp1.ObjectCount != 1 {
		t.Errorf("dhcp1 ObjectCount = %d, want 1 (network 10.0.1.0/24 via dhcp_member)", dhcp1.ObjectCount)
	}
}

// TestNIOS_PerMemberActiveIPs verifies that Active IP FindingRows are emitted per-member
// with correct Source hostnames, not as a single grid-level row on GM.
//
// Expected per-member attribution:
//   - gm.test.local (owns 10.0.0.0/24): leases 10.0.0.1,.2,.3 (vnode) + fixed 10.0.0.50
//     + host 10.0.0.51 + discovery 10.0.0.100 + network IPs 10.0.0.0, 10.0.0.255 = 8 IPs
//   - dhcp1.test.local (owns 10.0.1.0/24): lease 10.0.0.20 (vnode) + network IPs
//     10.0.1.0, 10.0.1.255 = 3 IPs
func TestNIOS_PerMemberActiveIPs(t *testing.T) {
	rows := runScan(t)

	// Collect Active IP rows by Source.
	activeBySource := make(map[string]int)
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			activeBySource[r.Source] += r.Count
			// All per-member rows should use "Active IPs" as item name.
			if r.Item != "Active IPs" {
				t.Errorf("expected item 'Active IPs' for source %s; got %q", r.Source, r.Item)
			}
		}
	}

	// Must have at least 2 members with Active IPs (GM + dhcp1).
	if len(activeBySource) < 2 {
		t.Fatalf("expected >= 2 members with Active IP rows; got %d: %+v", len(activeBySource), activeBySource)
	}

	// GM should have 8 IPs (3 leases + fixed + host + discovery + 2 network IPs from 10.0.0.0/24).
	if gmIPs := activeBySource["gm.test.local"]; gmIPs != 8 {
		t.Errorf("gm.test.local Active IPs = %d, want 8", gmIPs)
	}

	// dhcp1 should have 3 IPs (1 lease via vnode + 2 network IPs from 10.0.1.0/24).
	if dhcp1IPs := activeBySource["dhcp1.test.local"]; dhcp1IPs != 3 {
		t.Errorf("dhcp1.test.local Active IPs = %d, want 3", dhcp1IPs)
	}

	// No single "NIOS Active IPs (All Sources)" row should exist.
	for _, r := range rows {
		if r.Item == "NIOS Active IPs (All Sources)" {
			t.Errorf("unexpected grid-level Active IPs row: %+v", r)
		}
	}
}

// serviceRoleFixtureXML returns a minimal onedb.xml with 3 virtual_nodes that have
// NO enable_dns/enable_dhcp properties, plus member_dns_properties and
// member_dhcp_properties in positional order to test synthetic injection.
//
// Positional order (matching virtual_node appearance):
//   pos 0: GM        -> dns=true,  dhcp=true  (but GM role takes precedence)
//   pos 1: dns1      -> dns=true,  dhcp=false -> role should be "DNS"
//   pos 2: noservice -> dns=false, dhcp=false -> role should be "DNS/DHCP" (default)
func serviceRoleFixtureXML() string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<DATABASE NAME="onedb" VERSION="9.0.6-test">
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="201"/>
<PROPERTY NAME="host_name" VALUE="gm.role.local"/>
<PROPERTY NAME="is_grid_master" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="202"/>
<PROPERTY NAME="host_name" VALUE="dns1.role.local"/>
<PROPERTY NAME="is_grid_master" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="203"/>
<PROPERTY NAME="host_name" VALUE="noservice.role.local"/>
<PROPERTY NAME="is_grid_master" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dns_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dns_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dns_properties"/>
<PROPERTY NAME="service_enabled" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dhcp_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dhcp_properties"/>
<PROPERTY NAME="service_enabled" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dhcp_properties"/>
<PROPERTY NAME="service_enabled" VALUE="false"/>
</OBJECT>
</DATABASE>
`
}

// buildTarGz creates an in-memory tar.gz containing onedb.xml with the given content,
// writes it to a temp file, and returns its path. Caller must NOT delete the file
// (scanner.Scan will only delete files in os.TempDir, and the test file IS in TempDir).
func buildTarGz(t *testing.T, xmlContent string) string {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	data := []byte(xmlContent)
	if err := tw.WriteHeader(&tar.Header{Name: "onedb.xml", Mode: 0600, Size: int64(len(data))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(data); err != nil {
		t.Fatal(err)
	}
	tw.Close()
	gw.Close()
	f, err := os.CreateTemp("", "nios-test-*.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		t.Fatal(err)
	}
	f.Close()
	return f.Name()
}

// TestServiceRole_DNSOnly verifies that a member with member_dns_properties
// service_enabled=true and member_dhcp_properties service_enabled=false gets
// role "DNS", not the default "DNS/DHCP".
func TestServiceRole_DNSOnly(t *testing.T) {
	path := buildTarGz(t, serviceRoleFixtureXML())

	s := niosscanner.New()
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.role.local,dns1.role.local,noservice.role.local",
		},
	}
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}

	data := any(s).(NiosResultScanner).GetNiosServerMetricsJSON()
	var metrics []niosscanner.NiosServerMetric
	if err := json.Unmarshal(data, &metrics); err != nil {
		t.Fatal(err)
	}

	byHost := make(map[string]string)
	for _, m := range metrics {
		byHost[m.MemberID] = m.Role
	}

	// dns1 has dns=true, dhcp=false -> should be "DNS"
	if role := byHost["dns1.role.local"]; role != "DNS" {
		t.Errorf("dns1.role.local role = %q, want %q", role, "DNS")
	}
}

// TestServiceRole_ThreeMemberPositional verifies positional matching of
// member_dns_properties/member_dhcp_properties across all 3 members.
func TestServiceRole_ThreeMemberPositional(t *testing.T) {
	path := buildTarGz(t, serviceRoleFixtureXML())

	s := niosscanner.New()
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.role.local,dns1.role.local,noservice.role.local",
		},
	}
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan error: %v", err)
	}

	data := any(s).(NiosResultScanner).GetNiosServerMetricsJSON()
	var metrics []niosscanner.NiosServerMetric
	if err := json.Unmarshal(data, &metrics); err != nil {
		t.Fatal(err)
	}

	byHost := make(map[string]string)
	for _, m := range metrics {
		byHost[m.MemberID] = m.Role
	}

	// GM: is_grid_master=true takes precedence -> "GM"
	if role := byHost["gm.role.local"]; role != "GM" {
		t.Errorf("gm.role.local role = %q, want %q", role, "GM")
	}

	// dns1: dns=true, dhcp=false -> "DNS"
	if role := byHost["dns1.role.local"]; role != "DNS" {
		t.Errorf("dns1.role.local role = %q, want %q", role, "DNS")
	}

	// noservice: dns=false, dhcp=false -> "DNS/DHCP" (default fallback)
	if role := byHost["noservice.role.local"]; role != "DNS/DHCP" {
		t.Errorf("noservice.role.local role = %q, want %q", role, "DNS/DHCP")
	}
}

// TestServiceRole_LegacyBackupUnchanged verifies that when member_dns_properties
// and member_dhcp_properties are ABSENT (legacy backup), existing behavior is unchanged.
func TestServiceRole_LegacyBackupUnchanged(t *testing.T) {
	// Use the standard fixture which has enable_dhcp=true on dhcp1 but no
	// member_dns_properties / member_dhcp_properties objects.
	rows := runScan(t)
	_ = rows // just verify it doesn't crash

	path := openFixture(t)
	s := niosscanner.New()
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"backup_path":      path,
			"selected_members": "gm.test.local,dns1.test.local,dhcp1.test.local",
		},
	}
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatal(err)
	}

	data := any(s).(NiosResultScanner).GetNiosServerMetricsJSON()
	var metrics []niosscanner.NiosServerMetric
	if err := json.Unmarshal(data, &metrics); err != nil {
		t.Fatal(err)
	}

	byHost := make(map[string]string)
	for _, m := range metrics {
		byHost[m.MemberID] = m.Role
	}

	// dhcp1 has enable_dhcp=true directly on virtual_node -> "DHCP"
	if role := byHost["dhcp1.test.local"]; role != "DHCP" {
		t.Errorf("dhcp1.test.local role = %q, want %q (legacy enable_dhcp on virtual_node)", role, "DHCP")
	}
}
