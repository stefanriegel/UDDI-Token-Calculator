// Package exporter — Resource Savings sheet builder.
//
// Renders fleet-wide and per-member vCPU/RAM savings from migrating NIOS
// appliances to NIOS-X (self-managed) or NIOS-XaaS (fully managed). Reuses
// the Phase 26 calculator module (internal/calculator/vnios_specs.go) for
// all lookup and computation — this file is presentation only.
//
// Implements RES-13 (per-member columns) and RES-14 (dedicated sheet).
//
// KNOWN LIMITATION (Phase 28-01): the per-member target form factor is
// hardcoded to "nios-x" for every member. The wizard's `niosMigrationMap`
// (Map<memberId, formFactor>) lives in local React state and is not yet
// persisted to the session, so the exporter has no way to honor per-member
// XaaS selections at this time. A follow-up plan will plumb the form-factor
// map through the export request payload alongside variantOverrides.
package exporter

import (
	"fmt"
	"math"
	"strconv"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/xuri/excelize/v2"
)

// memberSavingsRow pairs a calculator.MemberSavings result with its source role
// (GM/GMC/Master/Regular) for display in the per-member detail table.
type memberSavingsRow struct {
	Savings calculator.MemberSavings
	Role    string
	QPS     int
	LPS     int
}

// buildResourceSavingsSheet writes the Resource Savings sheet with a fleet
// summary block followed by a per-member detail table. The variantOverrides
// map keys members by MemberID; nil/empty falls back to each spec's
// DefaultVariantIndex (Phase 28 D-15).
func buildResourceSavingsSheet(f *excelize.File, styles sheetStyles, sess *session.Session, variantOverrides map[string]int) error {
	members, err := parseNiosFullMetrics(sess.NiosServerMetricsJSON)
	if err != nil {
		return fmt.Errorf("exporter: decode NIOS metrics for Resource Savings: %w", err)
	}

	rows := computeMemberSavingsList(members, variantOverrides)
	savingsOnly := make([]calculator.MemberSavings, len(rows))
	for i, r := range rows {
		savingsOnly[i] = r.Savings
	}
	fleet := calculator.CalcFleetSavings(savingsOnly)

	sw, err := f.NewStreamWriter("Resource Savings")
	if err != nil {
		return fmt.Errorf("exporter: StreamWriter Resource Savings: %w", err)
	}

	// 16 columns wide (the per-member detail table is the wide path).
	widths := []float64{30, 12, 8, 8, 14, 14, 14, 10, 10, 14, 12, 10, 10, 10, 10, 50}
	for i, w := range widths {
		colName, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth("Resource Savings", colName, colName, w)
	}

	row := 1
	row, err = writeResourceSavingsSummary(sw, styles, fleet, row)
	if err != nil {
		return err
	}
	if err := writeResourceSavingsDetailTable(sw, styles, rows, row); err != nil {
		return err
	}

	return sw.Flush()
}

// computeMemberSavingsList walks parsed NIOS metrics, skips infra-only members
// (GM/GMC with no workload), and calls calculator.CalcMemberSavings for the
// remainder. Target form factor is hardcoded to "nios-x" — see KNOWN LIMITATION
// in the package doc comment above.
func computeMemberSavingsList(members []niosServerMetricFull, overrides map[string]int) []memberSavingsRow {
	out := make([]memberSavingsRow, 0, len(members))
	for i := range members {
		m := &members[i]
		if isInfraOnlyMember(m) {
			continue
		}

		variantIdx := -1
		if overrides != nil {
			if v, ok := overrides[m.MemberID]; ok {
				variantIdx = v
			}
		}

		tierName, _ := calcServerTokenTier(m.QPS, m.LPS, serverSizingObjects(m))

		input := calculator.MemberSavingsInput{
			MemberID:   m.MemberID,
			MemberName: m.MemberName,
			Model:      m.Model,
			Platform:   calculator.AppliancePlatform(m.Platform),
		}
		savings := calculator.CalcMemberSavings(input, tierName, "nios-x", variantIdx)

		out = append(out, memberSavingsRow{Savings: savings, Role: m.Role, QPS: m.QPS, LPS: m.LPS})
	}
	return out
}

// pctOfOld returns the integer percentage of newAbs/oldAbs (e.g. -54). Returns 0
// when oldAbs is 0 to avoid division-by-zero/NaN in the empty fleet case.
func pctOfOld(delta, old int) int {
	if old == 0 {
		return 0
	}
	return int(math.Round(float64(delta) / float64(old) * 100))
}

func pctOfOldF(delta, old float64) int {
	if old == 0 {
		return 0
	}
	return int(math.Round(delta / old * 100))
}

// writeResourceSavingsSummary writes the fleet summary block (rows 1..N) and
// returns the next free row index for the per-member detail table.
func writeResourceSavingsSummary(sw *excelize.StreamWriter, styles sheetStyles, fleet calculator.FleetSavings, row int) (int, error) {
	section := func(label string) error {
		cell, _ := excelize.CoordinatesToCellName(1, row)
		err := sw.SetRow(cell, []interface{}{
			excelize.Cell{StyleID: styles.sectionHeader, Value: label},
		})
		row++
		return err
	}
	plain := func(cells ...interface{}) error {
		cell, _ := excelize.CoordinatesToCellName(1, row)
		err := sw.SetRow(cell, cells)
		row++
		return err
	}
	blank := func() error { return plain("") }

	if err := section("FLEET RESOURCE FOOTPRINT REDUCTION"); err != nil {
		return row, err
	}

	excludedCount := len(fleet.UnknownModels) + len(fleet.InvalidCombinations)
	analyzed := fleet.MemberCount

	if err := plain("Total members analyzed:", analyzed); err != nil {
		return row, err
	}
	if err := plain("Members → NIOS-X (self-managed):", fleet.NiosXSavings.MemberCount); err != nil {
		return row, err
	}
	if err := plain("Members → NIOS-XaaS (managed):", fleet.XaasSavings.MemberCount); err != nil {
		return row, err
	}
	if err := plain("Members excluded (unknown/invalid):", excludedCount); err != nil {
		return row, err
	}
	if err := blank(); err != nil {
		return row, err
	}

	// BEFORE / AFTER / DELTA block — three columns: Metric label | vCPU | RAM(GB)
	if err := plain(
		excelize.Cell{StyleID: styles.header, Value: ""},
		excelize.Cell{StyleID: styles.header, Value: "vCPU"},
		excelize.Cell{StyleID: styles.header, Value: "RAM (GB)"},
	); err != nil {
		return row, err
	}
	if err := plain("BEFORE", fleet.TotalOldVCPU, fleet.TotalOldRamGB); err != nil {
		return row, err
	}
	if err := plain("AFTER", fleet.TotalNewVCPU, fleet.TotalNewRamGB); err != nil {
		return row, err
	}

	deltaVCPUPct := pctOfOld(fleet.TotalDeltaVCPU, fleet.TotalOldVCPU)
	deltaRAMPct := pctOfOldF(fleet.TotalDeltaRamGB, fleet.TotalOldRamGB)
	if err := plain(
		excelize.Cell{StyleID: styles.total, Value: fmt.Sprintf("DELTA (%d%% vCPU / %d%% RAM)", deltaVCPUPct, deltaRAMPct)},
		excelize.Cell{StyleID: styles.total, Value: fleet.TotalDeltaVCPU},
		excelize.Cell{StyleID: styles.total, Value: fleet.TotalDeltaRamGB},
	); err != nil {
		return row, err
	}
	if err := blank(); err != nil {
		return row, err
	}

	// SELF-MANAGED SAVINGS sub-block.
	if err := section("SELF-MANAGED SAVINGS (NIOS-X):"); err != nil {
		return row, err
	}
	if err := plain(
		excelize.Cell{
			StyleID: styles.slateCell,
			Value: fmt.Sprintf("%d vCPU, %g GB RAM across %d members",
				fleet.NiosXSavings.VCPU, fleet.NiosXSavings.RamGB, fleet.NiosXSavings.MemberCount),
		},
	); err != nil {
		return row, err
	}
	if err := blank(); err != nil {
		return row, err
	}

	// FULLY ELIMINATED sub-block.
	if err := section("FULLY ELIMINATED (NIOS-XaaS):"); err != nil {
		return row, err
	}
	if err := plain(
		excelize.Cell{
			StyleID: styles.emeraldCell,
			Value: fmt.Sprintf("%d vCPU, %g GB RAM across %d members",
				fleet.XaasSavings.VCPU, fleet.XaasSavings.RamGB, fleet.XaasSavings.MemberCount),
		},
	); err != nil {
		return row, err
	}
	if err := plain("✨ Zero customer footprint — managed by Infoblox"); err != nil {
		return row, err
	}
	if err := blank(); err != nil {
		return row, err
	}

	// PHYSICAL DECOMMISSION sub-block.
	if err := section("PHYSICAL DECOMMISSION:"); err != nil {
		return row, err
	}
	if err := plain(fmt.Sprintf("%d physical units retired", fleet.PhysicalUnitsRetired)); err != nil {
		return row, err
	}
	if err := plain("Frees: rack space · power · cooling"); err != nil {
		return row, err
	}
	if err := blank(); err != nil {
		return row, err
	}

	// ASSUMPTIONS bullet block.
	if err := section("ASSUMPTIONS"); err != nil {
		return row, err
	}
	for _, line := range []string{
		"• AWS baseline: r6i (current generation) unless overridden",
		"• X6 baseline: Small configuration unless overridden",
		"• Excluded members: unknown model or VMware-only on cloud",
	} {
		if err := plain(excelize.Cell{StyleID: styles.assumption, Value: line}); err != nil {
			return row, err
		}
	}
	if err := blank(); err != nil {
		return row, err
	}

	return row, nil
}

// writeResourceSavingsDetailTable writes the per-member detail header and data
// rows starting at startRow.
func writeResourceSavingsDetailTable(sw *excelize.StreamWriter, styles sheetStyles, rows []memberSavingsRow, startRow int) error {
	headers := []string{
		"Member Name", "Role", "QPS", "LPS",
		"Old Model", "Old Platform", "Old Variant",
		"Old vCPU", "Old RAM", "Target", "New Tier", "New vCPU", "New RAM",
		"Δ vCPU", "Δ RAM", "Notes",
	}
	headerCells := make([]interface{}, len(headers))
	for i, h := range headers {
		headerCells[i] = excelize.Cell{StyleID: styles.header, Value: h}
	}
	cell, _ := excelize.CoordinatesToCellName(1, startRow)
	if err := sw.SetRow(cell, headerCells); err != nil {
		return err
	}

	for i, r := range rows {
		s := r.Savings
		oldVariant := lookupVariantName(s.OldModel, s.OldPlatform, s.OldVariantIndex)
		target := "NIOS-X"
		if s.TargetFormFactor == "nios-xaas" {
			target = "NIOS-XaaS"
		}

		notesValue, notesStyle := resolveNotes(s, styles)
		var notesCell interface{}
		if notesStyle != 0 {
			notesCell = excelize.Cell{StyleID: notesStyle, Value: notesValue}
		} else {
			notesCell = notesValue
		}

		dataRow := []interface{}{
			s.MemberName,
			r.Role,
			r.QPS,
			r.LPS,
			s.OldModel,
			string(s.OldPlatform),
			oldVariant,
			s.OldVCPU,
			s.OldRamGB,
			target,
			s.NewTierName,
			s.NewVCPU,
			s.NewRamGB,
			s.DeltaVCPU,
			s.DeltaRamGB,
			notesCell,
		}
		cellAddr, _ := excelize.CoordinatesToCellName(1, startRow+1+i)
		if err := sw.SetRow(cellAddr, dataRow); err != nil {
			return err
		}
	}
	return nil
}

// lookupVariantName resolves the variant config name for the per-member detail
// table. Returns "—" on lookup miss to mirror the UI's empty-state glyph.
func lookupVariantName(model string, platform calculator.AppliancePlatform, variantIdx int) string {
	spec, ok := calculator.LookupApplianceSpec(model, platform)
	if !ok {
		return "—"
	}
	if variantIdx < 0 || variantIdx >= len(spec.Variants) {
		variantIdx = spec.DefaultVariantIndex
	}
	if variantIdx < 0 || variantIdx >= len(spec.Variants) {
		return "—"
	}
	return spec.Variants[variantIdx].ConfigName
}

// resolveNotes returns the literal Notes text and the style ID for the colored
// background pill. Style ID 0 means "no special style" (normal NIOS-X row).
func resolveNotes(s calculator.MemberSavings, styles sheetStyles) (string, int) {
	switch {
	case s.LookupMissing:
		return "Unknown model — verify member configuration", styles.amberCell
	case s.InvalidPlatformForModel:
		return fmt.Sprintf("Model %s is not supported on %s (VMware-only)", s.OldModel, s.OldPlatform), styles.amberCell
	case s.FullyManaged:
		return "Fully managed by Infoblox", styles.emeraldCell
	case s.PhysicalDecommission:
		return "Physical decommission — frees rack space, power, and cooling", styles.slateCell
	}
	return "", 0
}

// strconvItoa is a tiny shim to keep import grouped consistently across helpers.
// (Some sub-helpers in this file may format integers locally; centralized here
// to avoid scattering strconv imports.)
var _ = strconv.Itoa
