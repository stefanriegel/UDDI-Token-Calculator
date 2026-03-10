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
			"selected_members": "gm.test.local,dns1.test.local",
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

// TestNIOS_ActiveIPCounts verifies that Active IP findings reflect the 3 active leases in the GM.
// RED: Scan() returns empty — test fails.
func TestNIOS_ActiveIPCounts(t *testing.T) {
	rows := runScan(t)

	totalActiveIPs := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryActiveIPs {
			totalActiveIPs += r.Count
		}
	}
	if totalActiveIPs < 3 {
		t.Errorf("expected total Active IPs >= 3; got %d (rows: %+v)", totalActiveIPs, rows)
	}
}

// TestNIOS_AssetCounts verifies that Managed Assets findings are present.
// RED: Scan() returns empty — test fails.
func TestNIOS_AssetCounts(t *testing.T) {
	rows := runScan(t)

	totalAssets := 0
	for _, r := range rows {
		if r.Category == calculator.CategoryManagedAssets {
			totalAssets += r.Count
		}
	}
	if totalAssets < 1 {
		t.Errorf("expected Managed Assets Count >= 1; got %d (rows: %+v)", totalAssets, rows)
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
	// The fixture has exactly 3 active leases. If totalActiveIPs > 3, double-counting occurred.
	if totalActiveIPs > 3 {
		t.Errorf("Active IP double-counting detected: total=%d but fixture has 3 unique active leases", totalActiveIPs)
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
			"selected_members": "gm.test.local,dns1.test.local",
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
