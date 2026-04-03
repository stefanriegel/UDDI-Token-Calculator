// Package exporter builds .xlsx export files from scan session data.
// The Build function is the single entry point; it writes a valid OOXML workbook
// to the supplied io.Writer using excelize StreamWriter (no disk writes).
package exporter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/xuri/excelize/v2"
)

// providerDisplayNames maps internal provider keys to display names used as sheet titles.
var providerDisplayNames = map[string]string{
	"aws":         "AWS",
	"azure":       "Azure",
	"gcp":         "GCP",
	"ad":          "AD",
	"nios":        "NIOS",
	"bluecat":     "Bluecat",
	"efficientip": "EfficientIP",
}

// providerDisplayName returns the human-readable name for a provider key.
func providerDisplayName(provider string) string {
	if name, ok := providerDisplayNames[provider]; ok {
		return name
	}
	return provider
}

// findingsByProvider filters findings to those matching the given provider key.
func findingsByProvider(findings []calculator.FindingRow, provider string) []calculator.FindingRow {
	var out []calculator.FindingRow
	for _, f := range findings {
		if f.Provider == provider {
			out = append(out, f)
		}
	}
	return out
}

// Build writes a structured .xlsx workbook to w from the given completed session.
// Returns an error if excelize fails to build any sheet; the caller should not write
// any HTTP response headers until Build returns successfully.
func Build(w io.Writer, sess *session.Session) error {
	f := excelize.NewFile()
	defer f.Close()

	// Create the header style once; reused across all sheets.
	headerStyle, err := f.NewStyle(&excelize.Style{
		Fill: excelize.Fill{Type: "pattern", Color: []string{"002B49"}, Pattern: 1},
		Font: &excelize.Font{Bold: true, Color: "FFFFFF"},
	})
	if err != nil {
		return fmt.Errorf("exporter: create header style: %w", err)
	}

	// Sheet 1 — Summary (rename default Sheet1).
	f.SetSheetName("Sheet1", "Summary")
	if err := buildSummarySheet(f, headerStyle, sess); err != nil {
		return err
	}

	// Sheet 2 — Token Calculation (always present).
	if _, err := f.NewSheet("Token Calculation"); err != nil {
		return fmt.Errorf("exporter: new sheet Token Calculation: %w", err)
	}
	if err := buildTokenCalcSheet(f, headerStyle, sess); err != nil {
		return err
	}

	// Sheets 3+ — Per-provider (conditional).
	for _, p := range []string{"aws", "azure", "gcp", "ad", "nios", "bluecat", "efficientip"} {
		rows := findingsByProvider(sess.TokenResult.Findings, p)
		if len(rows) == 0 {
			continue
		}
		sheetName := providerDisplayName(p)
		if _, err := f.NewSheet(sheetName); err != nil {
			return fmt.Errorf("exporter: new sheet %s: %w", sheetName, err)
		}
		if err := buildProviderSheet(f, headerStyle, sheetName, rows); err != nil {
			return err
		}
	}

	// Sheet — Errors (conditional).
	if len(sess.Errors) > 0 {
		if _, err := f.NewSheet("Errors"); err != nil {
			return fmt.Errorf("exporter: new sheet Errors: %w", err)
		}
		if err := buildErrorsSheet(f, headerStyle, sess); err != nil {
			return err
		}
	}

	// Sheet — AD Migration Planner (conditional: present when AD scan produced per-DC metrics).
	if len(sess.ADServerMetricsJSON) > 0 {
		if _, err := f.NewSheet("AD Migration Planner"); err != nil {
			return fmt.Errorf("exporter: new sheet AD Migration Planner: %w", err)
		}
		if err := buildADMigrationSheet(f, headerStyle, sess); err != nil {
			return err
		}
	}

	// Sheet — Migration Flags (conditional: present when NIOS backup scan found DHCP options or /32 host routes).
	if len(sess.NiosMigrationFlagsJSON) > 0 {
		var flags migrationFlagsExport
		if err := json.Unmarshal(sess.NiosMigrationFlagsJSON, &flags); err == nil {
			if len(flags.DHCPOptions) > 0 || len(flags.HostRoutes) > 0 {
				if _, err := f.NewSheet("Migration Flags"); err != nil {
					return fmt.Errorf("exporter: new sheet Migration Flags: %w", err)
				}
				if err := buildMigrationFlagsSheet(f, headerStyle, &flags); err != nil {
					return err
				}
			}
		}
	}

	// Sheet — Recommended SKUs (always present: MGMT is unconditional).
	if _, err := f.NewSheet("Recommended SKUs"); err != nil {
		return fmt.Errorf("exporter: new sheet Recommended SKUs: %w", err)
	}
	if err := buildSKUSheet(f, headerStyle, sess); err != nil {
		return err
	}

	var buf bytes.Buffer
	if _, err := f.WriteTo(&buf); err != nil {
		return fmt.Errorf("exporter: write xlsx: %w", err)
	}
	_, err = buf.WriteTo(w)
	return err
}

// buildSummarySheet writes the Summary sheet with token totals and provider subtotals.
func buildSummarySheet(f *excelize.File, headerStyle int, sess *session.Session) error {
	sw, err := f.NewStreamWriter("Summary")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter Summary: %w", err)
	}

	// Column widths MUST be set before the first SetRow call.
	if err := sw.SetColWidth(1, 1, 35); err != nil {
		return err
	}
	if err := sw.SetColWidth(2, 2, 20); err != nil {
		return err
	}

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: headerStyle, Value: v} }

	// Header row.
	if err := sw.SetRow("A1", []interface{}{h("Metric"), h("Value")}); err != nil {
		return err
	}

	tr := sess.TokenResult

	// Token totals.
	if err := sw.SetRow("A2", []interface{}{"Grand Total Tokens", tr.GrandTotal}); err != nil {
		return err
	}
	if err := sw.SetRow("A3", []interface{}{"DDI Object Tokens", tr.DDITokens}); err != nil {
		return err
	}
	if err := sw.SetRow("A4", []interface{}{"Active IP Tokens", tr.IPTokens}); err != nil {
		return err
	}
	if err := sw.SetRow("A5", []interface{}{"Managed Asset Tokens", tr.AssetTokens}); err != nil {
		return err
	}

	// Scan date and duration.
	scanDate := ""
	if sess.CompletedAt != nil {
		scanDate = sess.CompletedAt.Format("2006-01-02 15:04:05")
	}
	if err := sw.SetRow("A6", []interface{}{"Scan Date", scanDate}); err != nil {
		return err
	}

	duration := ""
	if sess.CompletedAt != nil && !sess.StartedAt.IsZero() {
		d := sess.CompletedAt.Sub(sess.StartedAt)
		mins := int(d.Minutes())
		secs := int(d.Seconds()) % 60
		duration = fmt.Sprintf("%dm %ds", mins, secs)
	}
	if err := sw.SetRow("A7", []interface{}{"Scan Duration", duration}); err != nil {
		return err
	}

	// Blank separator row.
	if err := sw.SetRow("A8", []interface{}{"", ""}); err != nil {
		return err
	}

	// Provider subtotals header.
	if err := sw.SetRow("A9", []interface{}{h("Provider"), h("Tokens")}); err != nil {
		return err
	}

	// Aggregate ManagementTokens per provider.
	providerTotals := map[string]int{}
	for _, row := range tr.Findings {
		providerTotals[row.Provider] += row.ManagementTokens
	}

	row := 10
	for _, p := range []string{"aws", "azure", "gcp", "ad", "nios", "bluecat", "efficientip"} {
		if total, ok := providerTotals[p]; ok {
			cell, _ := excelize.CoordinatesToCellName(1, row)
			if err := sw.SetRow(cell, []interface{}{providerDisplayName(p), total}); err != nil {
				return err
			}
			row++
		}
	}

	return sw.Flush()
}

// buildTokenCalcSheet writes the Token Calculation sheet with all FindingRow data.
func buildTokenCalcSheet(f *excelize.File, headerStyle int, sess *session.Session) error {
	sw, err := f.NewStreamWriter("Token Calculation")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter Token Calculation: %w", err)
	}

	if err := sw.SetColWidth(1, 7, 18); err != nil {
		return err
	}

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: headerStyle, Value: v} }

	if err := sw.SetRow("A1", []interface{}{
		h("Provider"), h("Source"), h("Region"), h("Item"), h("Count"), h("Divisor"), h("Management Tokens"),
	}); err != nil {
		return err
	}

	for i, row := range sess.TokenResult.Findings {
		cell, _ := excelize.CoordinatesToCellName(1, i+2)
		if err := sw.SetRow(cell, []interface{}{
			providerDisplayName(row.Provider),
			row.Source,
			row.Region,
			row.Item,
			row.Count,
			row.TokensPerUnit,
			row.ManagementTokens,
		}); err != nil {
			return err
		}
	}

	return sw.Flush()
}

// buildProviderSheet writes a per-provider sheet with the given FindingRow slice.
func buildProviderSheet(f *excelize.File, headerStyle int, sheetName string, rows []calculator.FindingRow) error {
	sw, err := f.NewStreamWriter(sheetName)
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter %s: %w", sheetName, err)
	}

	if err := sw.SetColWidth(1, 7, 18); err != nil {
		return err
	}

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: headerStyle, Value: v} }

	if err := sw.SetRow("A1", []interface{}{
		h("Source"), h("Region"), h("Category"), h("Item"), h("Count"), h("Tokens/Unit"), h("Management Tokens"),
	}); err != nil {
		return err
	}

	for i, row := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, i+2)
		if err := sw.SetRow(cell, []interface{}{
			row.Source,
			row.Region,
			row.Category,
			row.Item,
			row.Count,
			row.TokensPerUnit,
			row.ManagementTokens,
		}); err != nil {
			return err
		}
	}

	return sw.Flush()
}

// buildErrorsSheet writes the Errors sheet listing all ProviderErrors from the session.
func buildErrorsSheet(f *excelize.File, headerStyle int, sess *session.Session) error {
	sw, err := f.NewStreamWriter("Errors")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter Errors: %w", err)
	}

	if err := sw.SetColWidth(1, 1, 12); err != nil {
		return err
	}
	if err := sw.SetColWidth(2, 2, 20); err != nil {
		return err
	}
	if err := sw.SetColWidth(3, 3, 50); err != nil {
		return err
	}
	if err := sw.SetColWidth(4, 4, 22); err != nil {
		return err
	}

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: headerStyle, Value: v} }

	if err := sw.SetRow("A1", []interface{}{
		h("Provider"), h("Resource Type"), h("Error Message"), h("Timestamp"),
	}); err != nil {
		return err
	}

	timestamp := "unknown"
	if sess.CompletedAt != nil {
		timestamp = sess.CompletedAt.Format("2006-01-02 15:04:05")
	}

	for i, e := range sess.Errors {
		cell, _ := excelize.CoordinatesToCellName(1, i+2)
		if err := sw.SetRow(cell, []interface{}{
			e.Provider,
			e.Resource,
			e.Message,
			timestamp,
		}); err != nil {
			return err
		}
	}

	return sw.Flush()
}

// adMetricExport mirrors the JSON shape of ADServerMetric for deserialization.
type adMetricExport struct {
	Hostname              string `json:"hostname"`
	DNSObjects            int    `json:"dnsObjects"`
	DHCPObjects           int    `json:"dhcpObjects"`
	DHCPObjectsWithOverhead int  `json:"dhcpObjectsWithOverhead"`
	QPS                   int    `json:"qps"`
	LPS                   int    `json:"lps"`
	FormFactor            string `json:"formFactor"`
	Tier                  string `json:"tier"`
	ServerTokens          int    `json:"serverTokens"`
}

// niosMetricExport mirrors the JSON shape of NiosServerMetric for deserialization.
type niosMetricExport struct {
	QPS         int `json:"qps"`
	LPS         int `json:"lps"`
	ObjectCount int `json:"objectCount"`
}

// niosXTier mirrors the NIOS-X SERVER_TOKEN_TIERS from nios-calc.ts.
type niosXTier struct {
	maxQPS, maxLPS, maxObjects, serverTokens int
}

var niosXTiers = []niosXTier{
	{5_000, 75, 3_000, 130},
	{10_000, 150, 7_500, 250},
	{20_000, 200, 29_000, 470},
	{40_000, 300, 110_000, 880},
	{70_000, 400, 440_000, 1_900},
	{115_000, 675, 880_000, 2_700},
}

func calcNiosXServerTokens(qps, lps, objectCount int) int {
	for _, t := range niosXTiers {
		if qps <= t.maxQPS && lps <= t.maxLPS && objectCount <= t.maxObjects {
			return t.serverTokens
		}
	}
	return niosXTiers[len(niosXTiers)-1].serverTokens // cap at XL
}

// buildSKUSheet writes the Recommended SKUs sheet with MGMT (always) and SERV (conditional) rows.
func buildSKUSheet(f *excelize.File, headerStyle int, sess *session.Session) error {
	// Compute total server tokens from NIOS + AD JSON
	totalServerTokens := 0
	hasServerMetrics := false

	if len(sess.NiosServerMetricsJSON) > 0 {
		var niosMetrics []niosMetricExport
		if err := json.Unmarshal(sess.NiosServerMetricsJSON, &niosMetrics); err == nil && len(niosMetrics) > 0 {
			hasServerMetrics = true
			for _, m := range niosMetrics {
				totalServerTokens += calcNiosXServerTokens(m.QPS, m.LPS, m.ObjectCount)
			}
		}
	}
	if len(sess.ADServerMetricsJSON) > 0 {
		var adMetrics []adMetricExport
		if err := json.Unmarshal(sess.ADServerMetricsJSON, &adMetrics); err == nil && len(adMetrics) > 0 {
			hasServerMetrics = true
			for _, m := range adMetrics {
				totalServerTokens += m.ServerTokens
			}
		}
	}

	// StreamWriter setup
	sw, err := f.NewStreamWriter("Recommended SKUs")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter Recommended SKUs: %w", err)
	}
	_ = sw.SetColWidth(1, 1, 35) // SKU Code
	_ = sw.SetColWidth(2, 2, 40) // Description
	_ = sw.SetColWidth(3, 3, 15) // Pack Count

	// Header row
	if err := sw.SetRow("A1", []interface{}{
		excelize.Cell{StyleID: headerStyle, Value: "SKU Code"},
		excelize.Cell{StyleID: headerStyle, Value: "Description"},
		excelize.Cell{StyleID: headerStyle, Value: "Pack Count"},
	}); err != nil {
		return err
	}

	// MGMT row (always)
	mgmtPacks := int(math.Ceil(float64(sess.TokenResult.GrandTotal) / 1000))
	if err := sw.SetRow("A2", []interface{}{
		"IB-TOKENS-UDDI-MGMT-1000",
		"Management Token Pack (1000 tokens)",
		mgmtPacks,
	}); err != nil {
		return err
	}

	// SERV row (conditional)
	if hasServerMetrics && totalServerTokens > 0 {
		servPacks := int(math.Ceil(float64(totalServerTokens) / 500))
		if err := sw.SetRow("A3", []interface{}{
			"IB-TOKENS-UDDI-SERV-500",
			"Server Token Pack (500 tokens)",
			servPacks,
		}); err != nil {
			return err
		}
	}

	return sw.Flush()
}

// buildADMigrationSheet writes the AD Migration Planner sheet with per-DC tier data
// and scenario comparison. Uses StreamWriter for large dataset safety.
func buildADMigrationSheet(f *excelize.File, headerStyle int, sess *session.Session) error {
	var metrics []adMetricExport
	if err := json.Unmarshal(sess.ADServerMetricsJSON, &metrics); err != nil {
		return fmt.Errorf("exporter: decode ADServerMetricsJSON: %w", err)
	}

	sw, err := f.NewStreamWriter("AD Migration Planner")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter AD Migration Planner: %w", err)
	}

	// Set column widths
	for col, w := range map[int]float64{1: 20, 2: 14, 3: 14, 4: 18, 5: 10, 6: 10, 7: 14, 8: 14} {
		colName, _ := excelize.ColumnNumberToName(col)
		_ = f.SetColWidth("AD Migration Planner", colName, colName, w)
	}

	// Header row
	headers := []interface{}{
		excelize.Cell{StyleID: headerStyle, Value: "DC Hostname"},
		excelize.Cell{StyleID: headerStyle, Value: "DNS Objects"},
		excelize.Cell{StyleID: headerStyle, Value: "DHCP Objects"},
		excelize.Cell{StyleID: headerStyle, Value: "DHCP Objects (+20%)"},
		excelize.Cell{StyleID: headerStyle, Value: "QPS"},
		excelize.Cell{StyleID: headerStyle, Value: "LPS"},
		excelize.Cell{StyleID: headerStyle, Value: "Form Factor"},
		excelize.Cell{StyleID: headerStyle, Value: "NIOS-X Tier"},
		excelize.Cell{StyleID: headerStyle, Value: "Server Tokens"},
	}
	if err := sw.SetRow("A1", headers); err != nil {
		return err
	}

	// Data rows
	totalServerTokens := 0
	for i, m := range metrics {
		cell, _ := excelize.CoordinatesToCellName(1, i+2)
		formFactor := m.FormFactor
		if formFactor == "" {
			formFactor = "NIOS-X"
		}
		if err := sw.SetRow(cell, []interface{}{
			m.Hostname,
			m.DNSObjects,
			m.DHCPObjects,
			m.DHCPObjectsWithOverhead,
			m.QPS,
			m.LPS,
			formFactor,
			m.Tier,
			m.ServerTokens,
		}); err != nil {
			return err
		}
		totalServerTokens += m.ServerTokens
	}

	// Blank row + totals
	row := len(metrics) + 3
	cell, _ := excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		excelize.Cell{StyleID: headerStyle, Value: "TOTAL"},
		"", "", "", "", "", "", "",
		excelize.Cell{StyleID: headerStyle, Value: totalServerTokens},
	})

	// Scenario comparison section
	row += 2
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		excelize.Cell{StyleID: headerStyle, Value: "Migration Scenario"},
		excelize.Cell{StyleID: headerStyle, Value: "Server Tokens"},
		excelize.Cell{StyleID: headerStyle, Value: "Description"},
	})

	// Current: keep all DCs on existing licensing (0 server tokens)
	row++
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		"Current (No Migration)",
		0,
		"All DCs remain on current Windows DNS/DHCP licensing.",
	})

	// Hybrid: migrate 50% of DCs
	hybridTokens := 0
	half := len(metrics) / 2
	if half == 0 && len(metrics) > 0 {
		half = 1
	}
	for i := 0; i < half; i++ {
		hybridTokens += metrics[i].ServerTokens
	}
	row++
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		"Hybrid Migration",
		hybridTokens,
		fmt.Sprintf("Migrate %d of %d DCs to NIOS-X, remainder stay on Windows DNS/DHCP.", half, len(metrics)),
	})

	// Full: migrate all DCs
	row++
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		"Full Migration",
		totalServerTokens,
		fmt.Sprintf("Migrate all %d DCs to NIOS-X.", len(metrics)),
	})

	// Summary metrics section
	row += 2
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		excelize.Cell{StyleID: headerStyle, Value: "Summary Metrics"},
	})

	// Knowledge Worker count, computer count, static IP count from findings
	kwCount := 0
	compCount := 0
	staticIPCount := 0
	for _, finding := range sess.TokenResult.Findings {
		switch finding.Item {
		case "user_account":
			if finding.Provider == "ad" {
				kwCount += finding.Count
			}
		case "computer_count":
			if finding.Provider == "ad" {
				compCount += finding.Count
			}
		case "static_ip_count":
			if finding.Provider == "ad" {
				staticIPCount += finding.Count
			}
		}
	}

	row++
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{"Knowledge Workers (AD Users)", kwCount})

	row++
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{"Computer Inventory (Managed Assets)", compCount})

	row++
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{"Static IPs (Active IPs)", staticIPCount})

	// Note about form factor defaults
	row += 2
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{"Note: Form Factor defaults to NIOS-X. Use the interactive planner for per-DC XaaS scenarios."})

	return sw.Flush()
}

// migrationFlagsExport mirrors the NiosMigrationFlags JSON structure for deserialization.
type migrationFlagsExport struct {
	DHCPOptions []dhcpOptionFlagExport `json:"dhcpOptions"`
	HostRoutes  []hostRouteFlagExport  `json:"hostRoutes"`
}

type dhcpOptionFlagExport struct {
	Network      string `json:"network"`
	OptionNumber int    `json:"optionNumber"`
	OptionName   string `json:"optionName"`
	OptionType   string `json:"optionType"`
	Flag         string `json:"flag"`
	Member       string `json:"member"`
}

type hostRouteFlagExport struct {
	Network string `json:"network"`
	Member  string `json:"member"`
}

// buildMigrationFlagsSheet writes the Migration Flags sheet with two table sections:
// DHCP Options and Host Routes. Follows the AD Migration Planner pattern.
func buildMigrationFlagsSheet(f *excelize.File, headerStyle int, flags *migrationFlagsExport) error {
	sw, err := f.NewStreamWriter("Migration Flags")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter Migration Flags: %w", err)
	}

	// Set column widths.
	for col, w := range map[int]float64{1: 28, 2: 12, 3: 20, 4: 18, 5: 22, 6: 30} {
		colName, _ := excelize.ColumnNumberToName(col)
		_ = f.SetColWidth("Migration Flags", colName, colName, w)
	}

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: headerStyle, Value: v} }
	row := 1

	// ---- Section 1: DHCP Options ----
	cell, _ := excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, []interface{}{"DHCP Options Requiring Migration Review"}); err != nil {
		return err
	}
	row++

	// Header row
	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, []interface{}{
		h("Network"),
		h("Option #"),
		h("Option Name"),
		h("Type"),
		h("Flag"),
		h("Member"),
	}); err != nil {
		return err
	}
	row++

	// Data rows
	for _, opt := range flags.DHCPOptions {
		cell, _ = excelize.CoordinatesToCellName(1, row)
		if err := sw.SetRow(cell, []interface{}{
			opt.Network,
			opt.OptionNumber,
			opt.OptionName,
			opt.OptionType,
			opt.Flag,
			opt.Member,
		}); err != nil {
			return err
		}
		row++
	}
	if len(flags.DHCPOptions) == 0 {
		cell, _ = excelize.CoordinatesToCellName(1, row)
		_ = sw.SetRow(cell, []interface{}{"No DHCP options flagged for review."})
		row++
	}

	// Blank row separator
	row += 2

	// ---- Section 2: Host Routes ----
	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, []interface{}{"Host Routes (/32 Networks)"}); err != nil {
		return err
	}
	row++

	cell, _ = excelize.CoordinatesToCellName(1, row)
	if err := sw.SetRow(cell, []interface{}{
		h("Network (/32)"),
		h("Member"),
	}); err != nil {
		return err
	}
	row++

	for _, hr := range flags.HostRoutes {
		cell, _ = excelize.CoordinatesToCellName(1, row)
		if err := sw.SetRow(cell, []interface{}{
			hr.Network,
			hr.Member,
		}); err != nil {
			return err
		}
		row++
	}
	if len(flags.HostRoutes) == 0 {
		cell, _ = excelize.CoordinatesToCellName(1, row)
		_ = sw.SetRow(cell, []interface{}{"No /32 host routes found."})
	}

	return sw.Flush()
}
