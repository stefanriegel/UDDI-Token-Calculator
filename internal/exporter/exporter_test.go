package exporter_test

import (
	"bytes"
	"testing"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/exporter"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/xuri/excelize/v2"
)

// testSession builds a minimal *session.Session for use in exporter tests.
// findings become the TokenResult via calculator.Calculate.
// If complete is true, State is ScanStateComplete and CompletedAt is set.
func testSession(findings []calculator.FindingRow, errors []session.ProviderError, complete bool) *session.Session {
	sess := &session.Session{
		ID:          "test-123",
		TokenResult: calculator.Calculate(findings),
		Errors:      errors,
	}
	if complete {
		now := time.Now()
		sess.State = session.ScanStateComplete
		sess.CompletedAt = &now
	} else {
		sess.State = session.ScanStateCreated
	}
	return sess
}

// awsFindings returns a slice of FindingRow with a single AWS DDI-Objects row.
func awsFindings() []calculator.FindingRow {
	return []calculator.FindingRow{
		{
			Provider:      "aws",
			Source:        "123456789",
			Region:        "us-east-1",
			Category:      calculator.CategoryDDIObjects,
			Item:          "vpc",
			Count:         50,
			TokensPerUnit: calculator.TokensPerDDIObject,
		},
	}
}

// threeFindings returns 3 FindingRow entries for row-count tests.
func threeFindings() []calculator.FindingRow {
	return []calculator.FindingRow{
		{
			Provider:      "aws",
			Source:        "111",
			Category:      calculator.CategoryDDIObjects,
			Item:          "vpc",
			Count:         25,
			TokensPerUnit: calculator.TokensPerDDIObject,
		},
		{
			Provider:      "aws",
			Source:        "111",
			Category:      calculator.CategoryActiveIPs,
			Item:          "ec2_ip",
			Count:         13,
			TokensPerUnit: calculator.TokensPerActiveIP,
		},
		{
			Provider:      "aws",
			Source:        "111",
			Category:      calculator.CategoryManagedAssets,
			Item:          "ec2_instance",
			Count:         3,
			TokensPerUnit: calculator.TokensPerManagedAsset,
		},
	}
}

// openResult calls exporter.Build and opens the resulting bytes with excelize.OpenReader.
// Returns the opened file and the bytes buffer for further inspection, or fails the test.
func openResult(t *testing.T, sess *session.Session) *excelize.File {
	t.Helper()
	var buf bytes.Buffer
	if err := exporter.Build(&buf, sess); err != nil {
		t.Fatalf("Build() returned error: %v", err)
	}
	f, err := excelize.OpenReader(&buf)
	if err != nil {
		t.Fatalf("excelize.OpenReader() returned error: %v", err)
	}
	return f
}

// sheetExists returns true if name appears in f.GetSheetList().
func sheetExists(f *excelize.File, name string) bool {
	for _, s := range f.GetSheetList() {
		if s == name {
			return true
		}
	}
	return false
}

// TestBuild_SummarySheet asserts that Build produces a sheet named "Summary".
func TestBuild_SummarySheet(t *testing.T) {
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)
	if !sheetExists(f, "Summary") {
		t.Errorf("expected sheet %q to exist; got sheets: %v", "Summary", f.GetSheetList())
	}
}

// TestBuild_TokenCalcSheet asserts that Build produces a sheet named "Token Calculation".
func TestBuild_TokenCalcSheet(t *testing.T) {
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)
	if !sheetExists(f, "Token Calculation") {
		t.Errorf("expected sheet %q to exist; got sheets: %v", "Token Calculation", f.GetSheetList())
	}
}

// TestBuild_TokenCalcRowCount asserts that the "Token Calculation" sheet has
// 1 header row + len(findings) data rows = 4 rows total for 3 findings.
func TestBuild_TokenCalcRowCount(t *testing.T) {
	findings := threeFindings()
	sess := testSession(findings, nil, true)
	f := openResult(t, sess)
	rows, err := f.GetRows("Token Calculation")
	if err != nil {
		t.Fatalf("GetRows(Token Calculation): %v", err)
	}
	want := len(findings) + 1 // 1 header + n data rows
	if len(rows) != want {
		t.Errorf("expected %d rows in Token Calculation, got %d", want, len(rows))
	}
}

// TestBuild_ProviderTab asserts that when findings include "aws" rows,
// Build produces a sheet named "AWS".
func TestBuild_ProviderTab(t *testing.T) {
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)
	if !sheetExists(f, "AWS") {
		t.Errorf("expected sheet %q to exist; got sheets: %v", "AWS", f.GetSheetList())
	}
}

// TestBuild_ProviderTabOmitted asserts that when findings contain no "azure" rows,
// no "Azure" sheet is created.
func TestBuild_ProviderTabOmitted(t *testing.T) {
	// Only AWS findings — no Azure data.
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)
	if sheetExists(f, "Azure") {
		t.Errorf("expected sheet %q to NOT exist; got sheets: %v", "Azure", f.GetSheetList())
	}
}

// TestBuild_ErrorsTab asserts that when sess.Errors is non-empty,
// Build produces a sheet named "Errors".
func TestBuild_ErrorsTab(t *testing.T) {
	errors := []session.ProviderError{
		{Provider: "aws", Resource: "ec2", Message: "access denied"},
	}
	sess := testSession(awsFindings(), errors, true)
	f := openResult(t, sess)
	if !sheetExists(f, "Errors") {
		t.Errorf("expected sheet %q to exist; got sheets: %v", "Errors", f.GetSheetList())
	}
}

// TestBuild_ErrorsTabOmitted asserts that when sess.Errors is empty,
// no "Errors" sheet is created.
func TestBuild_ErrorsTabOmitted(t *testing.T) {
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)
	if sheetExists(f, "Errors") {
		t.Errorf("expected sheet %q to NOT exist; got sheets: %v", "Errors", f.GetSheetList())
	}
}

// TestBuild_ADMigrationPlannerSheet asserts that when ADServerMetricsJSON is set,
// the "AD Migration Planner" sheet is created with expected headers and data.
func TestBuild_ADMigrationPlannerSheet(t *testing.T) {
	adFindings := []calculator.FindingRow{
		{Provider: "ad", Source: "DC01", Category: calculator.CategoryDDIObjects, Item: "dns_zone", Count: 10, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: 1},
		{Provider: "ad", Source: "DC01", Category: calculator.CategoryManagedAssets, Item: "user_account", Count: 500, TokensPerUnit: calculator.TokensPerManagedAsset, ManagementTokens: 5},
		{Provider: "ad", Source: "DC01", Category: calculator.CategoryManagedAssets, Item: "computer_count", Count: 200, TokensPerUnit: calculator.TokensPerManagedAsset, ManagementTokens: 2},
		{Provider: "ad", Source: "DC01", Category: calculator.CategoryActiveIPs, Item: "static_ip_count", Count: 50, TokensPerUnit: calculator.TokensPerActiveIP, ManagementTokens: 1},
	}

	sess := testSession(adFindings, nil, true)
	sess.ADServerMetricsJSON = []byte(`[
		{"hostname":"DC01","dnsObjects":100,"dhcpObjects":50,"dhcpObjectsWithOverhead":60,"qps":0,"lps":0,"tier":"2XS","serverTokens":130},
		{"hostname":"DC02","dnsObjects":5000,"dhcpObjects":3000,"dhcpObjectsWithOverhead":3600,"qps":1000,"lps":50,"tier":"XS","serverTokens":250}
	]`)

	f := openResult(t, sess)
	if !sheetExists(f, "AD Migration Planner") {
		t.Fatalf("expected sheet %q to exist; got sheets: %v", "AD Migration Planner", f.GetSheetList())
	}

	// Verify header row
	cellA1, _ := f.GetCellValue("AD Migration Planner", "A1")
	if cellA1 != "DC Hostname" {
		t.Errorf("A1 = %q, want 'DC Hostname'", cellA1)
	}
	cellG1, _ := f.GetCellValue("AD Migration Planner", "G1")
	if cellG1 != "Form Factor" {
		t.Errorf("G1 = %q, want 'Form Factor'", cellG1)
	}
	cellH1, _ := f.GetCellValue("AD Migration Planner", "H1")
	if cellH1 != "NIOS-X Tier" {
		t.Errorf("H1 = %q, want 'NIOS-X Tier'", cellH1)
	}
	cellI1, _ := f.GetCellValue("AD Migration Planner", "I1")
	if cellI1 != "Server Tokens" {
		t.Errorf("I1 = %q, want 'Server Tokens'", cellI1)
	}

	// Verify data rows
	cellA2, _ := f.GetCellValue("AD Migration Planner", "A2")
	if cellA2 != "DC01" {
		t.Errorf("A2 = %q, want 'DC01'", cellA2)
	}
	cellA3, _ := f.GetCellValue("AD Migration Planner", "A3")
	if cellA3 != "DC02" {
		t.Errorf("A3 = %q, want 'DC02'", cellA3)
	}
	cellG2, _ := f.GetCellValue("AD Migration Planner", "G2")
	if cellG2 != "NIOS-X" {
		t.Errorf("G2 (form factor) = %q, want 'NIOS-X'", cellG2)
	}
	cellH2, _ := f.GetCellValue("AD Migration Planner", "H2")
	if cellH2 != "2XS" {
		t.Errorf("H2 (tier) = %q, want '2XS'", cellH2)
	}
}

// TestBuild_ADMigrationPlannerOmitted asserts that when ADServerMetricsJSON is nil/empty,
// no "AD Migration Planner" sheet is created.
func TestBuild_ADMigrationPlannerOmitted(t *testing.T) {
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)
	if sheetExists(f, "AD Migration Planner") {
		t.Errorf("expected sheet %q to NOT exist when ADServerMetricsJSON is empty; got sheets: %v", "AD Migration Planner", f.GetSheetList())
	}
}

// TestBuild_SKUSheet_WithServerMetrics asserts that the "Recommended SKUs" sheet
// contains correct MGMT and SERV pack counts when AD server metrics are present.
func TestBuild_SKUSheet_WithServerMetrics(t *testing.T) {
	// Use testSession with findings, then override TokenResult.GrandTotal directly
	// for deterministic pack count testing.
	sess := testSession(awsFindings(), nil, true)
	sess.TokenResult.GrandTotal = 2500 // → ceil(2500/1000) = 3 MGMT packs
	// AD server metrics: one entry with serverTokens=800 → ceil(800/500) = 2 SERV packs
	sess.ADServerMetricsJSON = []byte(`[{"hostname":"DC01","dnsObjects":100,"dhcpObjects":50,"dhcpObjectsWithOverhead":60,"qps":0,"lps":0,"tier":"2XS","serverTokens":800}]`)

	f := openResult(t, sess)

	if !sheetExists(f, "Recommended SKUs") {
		t.Fatalf("expected sheet 'Recommended SKUs' to exist; got sheets: %v", f.GetSheetList())
	}

	// Header row
	a1, _ := f.GetCellValue("Recommended SKUs", "A1")
	if a1 != "SKU Code" {
		t.Errorf("A1 = %q, want 'SKU Code'", a1)
	}

	// MGMT row
	a2, _ := f.GetCellValue("Recommended SKUs", "A2")
	if a2 != "IB-TOKENS-UDDI-MGMT-1000" {
		t.Errorf("A2 (SKU Code) = %q, want 'IB-TOKENS-UDDI-MGMT-1000'", a2)
	}
	c2, _ := f.GetCellValue("Recommended SKUs", "C2")
	if c2 != "3" {
		t.Errorf("C2 (MGMT packs) = %q, want '3'", c2)
	}

	// SERV row
	a3, _ := f.GetCellValue("Recommended SKUs", "A3")
	if a3 != "IB-TOKENS-UDDI-SERV-500" {
		t.Errorf("A3 (SKU Code) = %q, want 'IB-TOKENS-UDDI-SERV-500'", a3)
	}
	c3, _ := f.GetCellValue("Recommended SKUs", "C3")
	if c3 != "2" {
		t.Errorf("C3 (SERV packs) = %q, want '2'", c3)
	}
}

// TestBuild_SKUSheet_NoServerMetrics asserts that the SERV row is absent
// when no server metrics JSON is provided.
func TestBuild_SKUSheet_NoServerMetrics(t *testing.T) {
	sess := testSession(awsFindings(), nil, true)
	f := openResult(t, sess)

	if !sheetExists(f, "Recommended SKUs") {
		t.Fatalf("expected sheet 'Recommended SKUs' to exist; got sheets: %v", f.GetSheetList())
	}

	// MGMT row should still be present
	a2, _ := f.GetCellValue("Recommended SKUs", "A2")
	if a2 != "IB-TOKENS-UDDI-MGMT-1000" {
		t.Errorf("A2 (SKU Code) = %q, want 'IB-TOKENS-UDDI-MGMT-1000'", a2)
	}

	// SERV row should be absent (A3 empty)
	a3, _ := f.GetCellValue("Recommended SKUs", "A3")
	if a3 != "" {
		t.Errorf("A3 should be empty when no server metrics; got %q", a3)
	}
}

// TestBuild_SKUSheet_WithNIOSMetrics asserts NIOS server token tier calculation
// produces correct SERV pack count.
func TestBuild_SKUSheet_WithNIOSMetrics(t *testing.T) {
	findings := []calculator.FindingRow{
		{
			Provider:         "nios",
			Source:           "grid01",
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_zone",
			Count:            1000,
			TokensPerUnit:    1,
			ManagementTokens: 1000,
		},
	}
	sess := testSession(findings, nil, true)
	// NIOS metrics: one member with qps=5000, lps=75, objectCount=3000 → tier 2XS → 130 server tokens
	// Another member with qps=15000, lps=150, objectCount=20000 → tier S → 470 server tokens
	// Total = 600 → ceil(600/500) = 2 SERV packs
	sess.NiosServerMetricsJSON = []byte(`[
		{"qps":5000,"lps":75,"objectCount":3000},
		{"qps":15000,"lps":150,"objectCount":20000}
	]`)

	f := openResult(t, sess)

	// MGMT: ceil(1000/1000) = 1
	c2, _ := f.GetCellValue("Recommended SKUs", "C2")
	if c2 != "1" {
		t.Errorf("C2 (MGMT packs) = %q, want '1'", c2)
	}

	// SERV: ceil(600/500) = 2
	a3, _ := f.GetCellValue("Recommended SKUs", "A3")
	if a3 != "IB-TOKENS-UDDI-SERV-500" {
		t.Errorf("A3 = %q, want 'IB-TOKENS-UDDI-SERV-500'", a3)
	}
	c3, _ := f.GetCellValue("Recommended SKUs", "C3")
	if c3 != "2" {
		t.Errorf("C3 (SERV packs) = %q, want '2'", c3)
	}
}
