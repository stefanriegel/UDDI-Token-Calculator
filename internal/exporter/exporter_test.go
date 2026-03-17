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
