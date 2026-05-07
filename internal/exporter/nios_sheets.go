// Package exporter — NIOS migration sheet builders.
//
// Three conditional sheets added to the Excel export when NiosServerMetricsJSON is present:
//   - NIOS Migration Scenarios: current vs full-UDDI token comparison
//   - NIOS Server Tokens: per-member tier and server token calculation
//   - NIOS Member Details: full metrics for all members including infra-only
package exporter

import (
	"encoding/json"
	"fmt"
	"math"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/xuri/excelize/v2"
)

// niosServerMetricFull is the full NIOS server metric struct for migration sheets.
// Used by the three NIOS migration sheets and the SKU sheet for infra-only filtering.
type niosServerMetricFull struct {
	MemberID        string          `json:"memberId"`
	MemberName      string          `json:"memberName"`
	Role            string          `json:"role"`
	Model           string          `json:"model"`
	Platform        string          `json:"platform"`
	QPS             int             `json:"qps"`
	LPS             int             `json:"lps"`
	ObjectCount     int             `json:"objectCount"`
	ActiveIPCount   int             `json:"activeIPCount"`
	ManagedIPCount  int             `json:"managedIPCount"`
	StaticHosts     int             `json:"staticHosts"`
	DynamicHosts    int             `json:"dynamicHosts"`
	DHCPUtilization int             `json:"dhcpUtilization"`
	Licenses        map[string]bool `json:"licenses,omitempty"`
}

// parseNiosFullMetrics unmarshals JSON-encoded NIOS server metrics.
func parseNiosFullMetrics(data []byte) ([]niosServerMetricFull, error) {
	var metrics []niosServerMetricFull
	if err := json.Unmarshal(data, &metrics); err != nil {
		return nil, fmt.Errorf("exporter: decode NiosServerMetricsJSON: %w", err)
	}
	return metrics, nil
}

// ceilDiv computes ceiling(n / d). Returns 0 if n is 0.
func ceilDiv(n, d int) int {
	if n == 0 {
		return 0
	}
	return (n + d - 1) / d
}

// calcUddiTokensAggregated computes UDDI management tokens using native rates (25/13/3).
// Aggregates counts per category, applies one ceiling division per category, then SUMS.
func calcUddiTokensAggregated(findings []calculator.FindingRow) int {
	var totalDDI, totalIP, totalAsset int
	for _, f := range findings {
		switch f.Category {
		case calculator.CategoryDDIObjects:
			totalDDI += f.Count
		case calculator.CategoryActiveIPs:
			totalIP += f.Count
		case calculator.CategoryManagedAssets:
			totalAsset += f.Count
		}
	}
	return ceilDiv(totalDDI, calculator.TokensPerDDIObject) +
		ceilDiv(totalIP, calculator.TokensPerActiveIP) +
		ceilDiv(totalAsset, calculator.TokensPerManagedAsset)
}

// calcNiosTokens computes NIOS licensing tokens using NIOS rates (50/25/13).
// Aggregates counts per category, applies one ceiling division per category, then takes MAX.
func calcNiosTokens(findings []calculator.FindingRow) int {
	var totalDDI, totalIP, totalAsset int
	for _, f := range findings {
		switch f.Category {
		case calculator.CategoryDDIObjects:
			totalDDI += f.Count
		case calculator.CategoryActiveIPs:
			totalIP += f.Count
		case calculator.CategoryManagedAssets:
			totalAsset += f.Count
		}
	}
	ddi := ceilDiv(totalDDI, calculator.NIOSTokensPerDDIObject)
	ip := ceilDiv(totalIP, calculator.NIOSTokensPerActiveIP)
	asset := ceilDiv(totalAsset, calculator.NIOSTokensPerManagedAsset)

	m := ddi
	if ip > m {
		m = ip
	}
	if asset > m {
		m = asset
	}
	return m
}

// applyGrowthBuffer applies a percentage growth buffer to a value.
func applyGrowthBuffer(value int, pct float64) int {
	return int(math.Ceil(float64(value) * (1 + pct)))
}

// applyGrowthToFindings returns a copy of findings with counts scaled by the growth buffer.
func applyGrowthToFindings(findings []calculator.FindingRow, pct float64) []calculator.FindingRow {
	out := make([]calculator.FindingRow, len(findings))
	for i, f := range findings {
		out[i] = f
		out[i].Count = applyGrowthBuffer(f.Count, pct)
	}
	return out
}

// serverSizingObjects returns the sizing object count for tier calculation.
func serverSizingObjects(m *niosServerMetricFull) int {
	return m.ObjectCount + m.ActiveIPCount
}

// isInfraOnlyMember returns true when a GM/GMC member has no workload metrics.
func isInfraOnlyMember(m *niosServerMetricFull) bool {
	if m.Role != "GM" && m.Role != "GMC" {
		return false
	}
	return m.QPS == 0 && m.LPS == 0 && m.ObjectCount == 0 && m.ActiveIPCount == 0
}

// tierNames maps tier index to display name.
var tierNames = []string{"2XS", "XS", "S", "M", "L", "XL"}

// calcServerTokenTier returns the tier name and server tokens for a member.
func calcServerTokenTier(qps, lps, sizingObjects int) (string, int) {
	for i, t := range niosXTiers {
		if qps <= t.maxQPS && lps <= t.maxLPS && sizingObjects <= t.maxObjects {
			return tierNames[i], t.serverTokens
		}
	}
	return tierNames[len(tierNames)-1], niosXTiers[len(niosXTiers)-1].serverTokens
}

// buildNiosMigrationScenariosSheet writes the NIOS Migration Scenarios sheet.
func buildNiosMigrationScenariosSheet(f *excelize.File, styles sheetStyles, sess *session.Session) error {
	metrics, err := parseNiosFullMetrics(sess.NiosServerMetricsJSON)
	if err != nil {
		return err
	}

	niosFindings := findingsByProvider(sess.TokenResult.Findings, "nios")

	// Current NIOS tokens (no growth buffer)
	currentNiosTokens := calcNiosTokens(niosFindings)

	// UDDI management tokens with 20% growth buffer
	bufferedFindings := applyGrowthToFindings(niosFindings, 0.20)
	uddiMgmtTokens := calcUddiTokensAggregated(bufferedFindings)

	// Total server tokens (non-infra-only members)
	totalServerTokens := 0
	for i := range metrics {
		if isInfraOnlyMember(&metrics[i]) {
			continue
		}
		totalServerTokens += calcNiosXServerTokens(metrics[i].QPS, metrics[i].LPS, serverSizingObjects(&metrics[i]))
	}

	sw, err := f.NewStreamWriter("NIOS Migration Scenarios")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter NIOS Migration Scenarios: %w", err)
	}

	_ = sw.SetColWidth(1, 1, 30)
	_ = sw.SetColWidth(2, 2, 22)
	_ = sw.SetColWidth(3, 3, 18)
	_ = sw.SetColWidth(4, 4, 60)

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: styles.header, Value: v} }
	n := func(v int) excelize.Cell { return excelize.Cell{StyleID: styles.number, Value: v} }

	if err := sw.SetRow("A1", []interface{}{
		h("Scenario"), h("Management Tokens"), h("Server Tokens"), h("Description"),
	}); err != nil {
		return err
	}

	// Row 2: Current (NIOS Only)
	if err := sw.SetRow("A2", []interface{}{
		"Current (NIOS Only)", n(currentNiosTokens), n(0), "Current NIOS licensing (no server tokens needed)",
	}); err != nil {
		return err
	}

	// Row 3: Full Universal DDI
	if err := sw.SetRow("A3", []interface{}{
		"Full Universal DDI", n(uddiMgmtTokens), n(totalServerTokens), "All members migrated to Universal DDI",
	}); err != nil {
		return err
	}

	// Row 4: blank separator
	if err := sw.SetRow("A4", []interface{}{""}); err != nil {
		return err
	}

	// Row 5: Note
	if err := sw.SetRow("A5", []interface{}{
		"Assumes 20% growth buffer. Management tokens use UDDI rates (25/13/3). Server tokens assume NIOS-X form factor for all members.",
	}); err != nil {
		return err
	}

	return sw.Flush()
}

// buildNiosServerTokensSheet writes the NIOS Server Tokens sheet (excludes infra-only).
func buildNiosServerTokensSheet(f *excelize.File, styles sheetStyles, sess *session.Session) error {
	metrics, err := parseNiosFullMetrics(sess.NiosServerMetricsJSON)
	if err != nil {
		return err
	}

	sw, err := f.NewStreamWriter("NIOS Server Tokens")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter NIOS Server Tokens: %w", err)
	}

	_ = sw.SetColWidth(1, 1, 30)
	_ = sw.SetColWidth(2, 2, 10)
	_ = sw.SetColWidth(3, 3, 15)
	_ = sw.SetColWidth(4, 4, 12)
	_ = sw.SetColWidth(5, 5, 10)
	_ = sw.SetColWidth(6, 6, 10)
	_ = sw.SetColWidth(7, 7, 15)
	_ = sw.SetColWidth(8, 8, 10)
	_ = sw.SetColWidth(9, 9, 15)

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: styles.header, Value: v} }
	n := func(v int) excelize.Cell { return excelize.Cell{StyleID: styles.number, Value: v} }

	if err := sw.SetRow("A1", []interface{}{
		h("Grid Member"), h("Role"), h("Model"), h("Platform"),
		h("QPS"), h("LPS"), h("Sizing Objects"), h("Tier"), h("Server Tokens"),
	}); err != nil {
		return err
	}

	row := 2
	totalServerTokens := 0
	for i := range metrics {
		if isInfraOnlyMember(&metrics[i]) {
			continue
		}
		m := &metrics[i]
		sizingObj := serverSizingObjects(m)
		tierName, tokens := calcServerTokenTier(m.QPS, m.LPS, sizingObj)
		totalServerTokens += tokens

		cell, _ := excelize.CoordinatesToCellName(1, row)
		if err := sw.SetRow(cell, []interface{}{
			m.MemberName, m.Role, m.Model, m.Platform,
			n(m.QPS), n(m.LPS), n(sizingObj), tierName, n(tokens),
		}); err != nil {
			return err
		}
		row++
	}

	// Blank separator
	cell, _ := excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{""})
	row++

	// TOTAL row
	cell, _ = excelize.CoordinatesToCellName(1, row)
	_ = sw.SetRow(cell, []interface{}{
		excelize.Cell{StyleID: styles.total, Value: "TOTAL"},
		"", "", "", "", "", "", "",
		excelize.Cell{StyleID: styles.total, Value: totalServerTokens},
	})

	return sw.Flush()
}

// buildNiosMemberDetailsSheet writes the NIOS Member Details sheet (ALL members).
func buildNiosMemberDetailsSheet(f *excelize.File, styles sheetStyles, sess *session.Session) error {
	metrics, err := parseNiosFullMetrics(sess.NiosServerMetricsJSON)
	if err != nil {
		return err
	}

	sw, err := f.NewStreamWriter("NIOS Member Details")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter NIOS Member Details: %w", err)
	}

	_ = sw.SetColWidth(1, 1, 30)
	_ = sw.SetColWidth(2, 2, 10)
	_ = sw.SetColWidth(3, 3, 15)
	_ = sw.SetColWidth(4, 4, 12)
	_ = sw.SetColWidth(5, 5, 10)
	_ = sw.SetColWidth(6, 6, 10)
	_ = sw.SetColWidth(7, 7, 12)
	_ = sw.SetColWidth(8, 8, 12)
	_ = sw.SetColWidth(9, 9, 12)
	_ = sw.SetColWidth(10, 10, 12)
	_ = sw.SetColWidth(11, 11, 12)
	_ = sw.SetColWidth(12, 12, 12)
	_ = sw.SetColWidth(13, 13, 10)

	h := func(v string) excelize.Cell { return excelize.Cell{StyleID: styles.header, Value: v} }
	n := func(v int) excelize.Cell { return excelize.Cell{StyleID: styles.number, Value: v} }

	if err := sw.SetRow("A1", []interface{}{
		h("Grid Member"), h("Role"), h("Model"), h("Platform"),
		h("QPS"), h("LPS"), h("DDI Objects"), h("Active IPs"),
		h("Managed IPs"), h("Static Hosts"), h("Dynamic Hosts"),
		h("DHCP Util %"), h("Infra Only"),
	}); err != nil {
		return err
	}

	for i, m := range metrics {
		cell, _ := excelize.CoordinatesToCellName(1, i+2)

		infraOnly := ""
		if isInfraOnlyMember(&metrics[i]) {
			infraOnly = "Yes"
		}

		// DHCP Utilization: permille to fraction for Excel percentage format
		dhcpUtil := float64(m.DHCPUtilization) / 1000.0

		if err := sw.SetRow(cell, []interface{}{
			m.MemberName, m.Role, m.Model, m.Platform,
			n(m.QPS), n(m.LPS), n(m.ObjectCount), n(m.ActiveIPCount),
			n(m.ManagedIPCount), n(m.StaticHosts), n(m.DynamicHosts),
			excelize.Cell{StyleID: styles.pct, Value: dhcpUtil}, infraOnly,
		}); err != nil {
			return err
		}
	}

	return sw.Flush()
}
