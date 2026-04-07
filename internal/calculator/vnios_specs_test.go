// vnios_specs_test.go — Go stdlib tests for the vNIOS appliance lookup table
// and resource savings calculator. Mirrors the vitest scenarios in
// frontend/src/app/components/resource-savings.test.ts (TS plan 26-01).
//
// White-box (package calculator) so tests can reach the unexported helpers
// (modelExistsOnAnyPlatform, niosXTierMinima) when needed.
package calculator

import (
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

// ─────────────────────────── Lookup tests (Task 1) ───────────────────────────

func TestVNIOSSpecsRowCount(t *testing.T) {
	// 8 X5/VMware + 5 X5/Azure + 5 X5/AWS + 5 X5/GCP +
	// 5 X6/VMware + 5 X6/Azure + 5 X6/AWS + 5 X6/GCP + 1 Physical = 44.
	if got := len(VNIOSSpecs); got < 39 {
		t.Errorf("VNIOSSpecs row count = %d, want >= 39", got)
	}
}

func TestLookupApplianceSpec_X6_VMware(t *testing.T) {
	spec, ok := LookupApplianceSpec("IB-V2326", PlatformVMware)
	if !ok {
		t.Fatal("LookupApplianceSpec(IB-V2326, VMware) returned ok=false")
	}
	if len(spec.Variants) != 2 {
		t.Fatalf("variants len = %d, want 2", len(spec.Variants))
	}
	if spec.Variants[0] != (ApplianceVariant{ConfigName: "Small", VCPU: 12, RamGB: 128}) {
		t.Errorf("variant[0] = %+v, want {Small, 12, 128}", spec.Variants[0])
	}
	if spec.Variants[1] != (ApplianceVariant{ConfigName: "Large", VCPU: 20, RamGB: 192}) {
		t.Errorf("variant[1] = %+v, want {Large, 20, 192}", spec.Variants[1])
	}
}

func TestLookupApplianceSpec_X5_AWS_3Variants(t *testing.T) {
	spec, ok := LookupApplianceSpec("IB-V2225", PlatformAWS)
	if !ok {
		t.Fatal("LookupApplianceSpec(IB-V2225, AWS) returned ok=false")
	}
	if len(spec.Variants) != 3 {
		t.Fatalf("variants len = %d, want 3", len(spec.Variants))
	}
	want := []struct {
		name  string
		vCPU  int
		ramGB float64
	}{
		{"r6i", 8, 64},
		{"m5", 8, 32},
		{"r4", 8, 61},
	}
	for i, w := range want {
		got := spec.Variants[i]
		if got.ConfigName != w.name || got.VCPU != w.vCPU || got.RamGB != w.ramGB {
			t.Errorf("variant[%d] = {%s, %d, %v}, want {%s, %d, %v}",
				i, got.ConfigName, got.VCPU, got.RamGB, w.name, w.vCPU, w.ramGB)
		}
	}
}

func TestLookupApplianceSpec_X6_GCP_3Variants(t *testing.T) {
	spec, ok := LookupApplianceSpec("IB-V926", PlatformGCP)
	if !ok {
		t.Fatal("LookupApplianceSpec(IB-V926, GCP) returned ok=false")
	}
	if len(spec.Variants) != 3 {
		t.Fatalf("variants len = %d, want 3", len(spec.Variants))
	}
	want := []struct {
		name  string
		vCPU  int
		ramGB float64
	}{
		{"Small", 8, 16},
		{"Medium", 8, 32},
		{"Large", 8, 64},
	}
	for i, w := range want {
		got := spec.Variants[i]
		if got.ConfigName != w.name || got.VCPU != w.vCPU || got.RamGB != w.ramGB {
			t.Errorf("variant[%d] = {%s, %d, %v}, want {%s, %d, %v}",
				i, got.ConfigName, got.VCPU, got.RamGB, w.name, w.vCPU, w.ramGB)
		}
	}
}

func TestLookupApplianceSpec_VMwareOnly_Flag(t *testing.T) {
	spec, ok := LookupApplianceSpec("IB-V2215", PlatformVMware)
	if !ok {
		t.Fatal("LookupApplianceSpec(IB-V2215, VMware) returned ok=false")
	}
	if !spec.VmwareOnly {
		t.Error("IB-V2215/VMware spec.VmwareOnly = false, want true")
	}
}

func TestLookupApplianceSpec_VMwareOnly_OnCloud(t *testing.T) {
	if _, ok := LookupApplianceSpec("IB-V2215", PlatformAzure); ok {
		t.Error("LookupApplianceSpec(IB-V2215, Azure) returned ok=true, want false")
	}
	if _, ok := LookupApplianceSpec("IB-V1415", PlatformAWS); ok {
		t.Error("LookupApplianceSpec(IB-V1415, AWS) returned ok=true, want false")
	}
}

func TestLookupApplianceSpec_UnknownModel(t *testing.T) {
	if _, ok := LookupApplianceSpec("IB-NoExist", PlatformVMware); ok {
		t.Error("LookupApplianceSpec for unknown model returned ok=true")
	}
}

func TestLookupApplianceSpec_Physical(t *testing.T) {
	spec, ok := LookupApplianceSpec("IB-4030", PlatformPhysical)
	if !ok {
		t.Fatal("LookupApplianceSpec(IB-4030, Physical) returned ok=false")
	}
	if spec.Generation != GenerationPhysical {
		t.Errorf("generation = %s, want Physical", spec.Generation)
	}
}

func TestLookupApplianceSpec_EveryRowReachable(t *testing.T) {
	for i, row := range VNIOSSpecs {
		got, ok := LookupApplianceSpec(row.Model, row.Platform)
		if !ok {
			t.Errorf("row %d (%s/%s) not reachable via LookupApplianceSpec",
				i, row.Model, row.Platform)
			continue
		}
		if got.Model != row.Model || got.Platform != row.Platform || got.Generation != row.Generation {
			t.Errorf("row %d roundtrip mismatch: got %+v want %+v", i, got, row)
		}
	}
}

// Additional sanity: count VMware-only rows.
func TestVNIOSSpecsVmwareOnlyCount(t *testing.T) {
	count := 0
	for _, s := range VNIOSSpecs {
		if s.VmwareOnly {
			count++
		}
	}
	if count != 3 {
		t.Errorf("VmwareOnly row count = %d, want 3 (IB-V815, IB-V1415, IB-V2215)", count)
	}
}

// ─────────────────────── CalcMemberSavings tests (Task 2) ───────────────────────

func TestCalcMemberSavings_VMware_X5_To_NiosX(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "m1", MemberName: "gm.example.com",
		Model: "IB-V2225", Platform: PlatformVMware,
	}
	got := CalcMemberSavings(in, "2XS", "nios-x", -1)
	if got.OldVCPU != 8 || got.OldRamGB != 64 {
		t.Errorf("old = %d/%v, want 8/64", got.OldVCPU, got.OldRamGB)
	}
	if got.NewVCPU != 3 || got.NewRamGB != 4 {
		t.Errorf("new = %d/%v, want 3/4", got.NewVCPU, got.NewRamGB)
	}
	if got.DeltaVCPU != -5 || got.DeltaRamGB != -60 {
		t.Errorf("delta = %d/%v, want -5/-60", got.DeltaVCPU, got.DeltaRamGB)
	}
	if got.PhysicalDecommission || got.FullyManaged {
		t.Errorf("flags wrong: phys=%v fully=%v", got.PhysicalDecommission, got.FullyManaged)
	}
}

func TestCalcMemberSavings_XaaS(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "m2", MemberName: "ns1.example.com",
		Model: "IB-V2326", Platform: PlatformVMware,
	}
	got := CalcMemberSavings(in, "", "nios-xaas", -1)
	if got.OldVCPU != 12 || got.OldRamGB != 128 {
		t.Errorf("old = %d/%v, want 12/128", got.OldVCPU, got.OldRamGB)
	}
	if got.NewVCPU != 0 || got.NewRamGB != 0 {
		t.Errorf("new = %d/%v, want 0/0", got.NewVCPU, got.NewRamGB)
	}
	if got.DeltaVCPU != -12 || got.DeltaRamGB != -128 {
		t.Errorf("delta = %d/%v, want -12/-128", got.DeltaVCPU, got.DeltaRamGB)
	}
	if !got.FullyManaged {
		t.Error("FullyManaged = false, want true")
	}
}

func TestCalcMemberSavings_PhysicalDecommission(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "p1", MemberName: "phys.example.com",
		Model: "IB-4030", Platform: PlatformPhysical,
	}
	got := CalcMemberSavings(in, "M", "nios-x", -1)
	if !got.PhysicalDecommission {
		t.Error("PhysicalDecommission = false, want true")
	}
	if got.OldGeneration != GenerationPhysical {
		t.Errorf("OldGeneration = %s, want Physical", got.OldGeneration)
	}
}

func TestCalcMemberSavings_AWSVariantOverride(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "a1", MemberName: "aws-ns",
		Model: "IB-V2225", Platform: PlatformAWS,
	}
	got := CalcMemberSavings(in, "M", "nios-x", 2) // r4
	if got.OldVCPU != 8 || got.OldRamGB != 61 {
		t.Errorf("old = %d/%v, want 8/61 (r4)", got.OldVCPU, got.OldRamGB)
	}
	if got.OldVariantIndex != 2 {
		t.Errorf("OldVariantIndex = %d, want 2", got.OldVariantIndex)
	}
}

func TestCalcMemberSavings_AWSDefaultVariant(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "a2", MemberName: "aws-ns2",
		Model: "IB-V2225", Platform: PlatformAWS,
	}
	got := CalcMemberSavings(in, "M", "nios-x", -1) // default = r6i
	if got.OldVCPU != 8 || got.OldRamGB != 64 {
		t.Errorf("old = %d/%v, want 8/64 (r6i)", got.OldVCPU, got.OldRamGB)
	}
	if got.OldVariantIndex != 0 {
		t.Errorf("OldVariantIndex = %d, want 0", got.OldVariantIndex)
	}
}

func TestCalcMemberSavings_UnknownModel(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "u1", MemberName: "ghost",
		Model: "IB-NOPE", Platform: PlatformVMware,
	}
	got := CalcMemberSavings(in, "2XS", "nios-x", -1)
	if !got.LookupMissing {
		t.Error("LookupMissing = false, want true")
	}
	if got.InvalidPlatformForModel {
		t.Error("InvalidPlatformForModel = true, want false")
	}
	if got.OldVCPU != 0 || got.OldRamGB != 0 {
		t.Errorf("old not zeroed: %d/%v", got.OldVCPU, got.OldRamGB)
	}
}

func TestCalcMemberSavings_VMwareOnlyOnCloud(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "i1", MemberName: "broken",
		Model: "IB-V2215", Platform: PlatformAzure,
	}
	got := CalcMemberSavings(in, "2XS", "nios-x", -1)
	if !got.InvalidPlatformForModel {
		t.Error("InvalidPlatformForModel = false, want true")
	}
	if got.LookupMissing {
		t.Error("LookupMissing = true, want false (model exists, just on wrong platform)")
	}
}

func TestCalcMemberSavings_EmptyModel(t *testing.T) {
	in := MemberSavingsInput{
		MemberID: "e1", MemberName: "noname",
		Model: "", Platform: PlatformVMware,
	}
	got := CalcMemberSavings(in, "2XS", "nios-x", -1)
	if !got.LookupMissing {
		t.Error("empty model: LookupMissing = false, want true")
	}
}

// ─────────────────────── CalcFleetSavings tests (Task 2) ───────────────────────

func TestCalcFleetSavings_MixedFleet(t *testing.T) {
	mk := func(model string, platform AppliancePlatform, formFactor, tier string, variant int) MemberSavings {
		return CalcMemberSavings(
			MemberSavingsInput{MemberID: model, MemberName: model, Model: model, Platform: platform},
			tier, formFactor, variant,
		)
	}
	members := []MemberSavings{
		mk("IB-V2225", PlatformVMware, "nios-x", "2XS", -1),    // NIOS-X
		mk("IB-V2326", PlatformVMware, "nios-x", "M", -1),      // NIOS-X
		mk("IB-V926", PlatformVMware, "nios-x", "S", -1),       // NIOS-X
		mk("IB-V2326", PlatformVMware, "nios-xaas", "", -1),    // XaaS
		mk("IB-4030", PlatformPhysical, "nios-x", "M", -1),     // physical → NIOS-X
		mk("IB-NOPE", PlatformVMware, "nios-x", "2XS", -1),     // unknown
	}
	fleet := CalcFleetSavings(members)

	if fleet.MemberCount != 6 {
		t.Errorf("MemberCount = %d, want 6", fleet.MemberCount)
	}
	if fleet.NiosXSavings.MemberCount != 4 {
		t.Errorf("NiosXSavings.MemberCount = %d, want 4 (3 X5/X6 + 1 physical)",
			fleet.NiosXSavings.MemberCount)
	}
	if fleet.XaasSavings.MemberCount != 1 {
		t.Errorf("XaasSavings.MemberCount = %d, want 1", fleet.XaasSavings.MemberCount)
	}
	if fleet.PhysicalUnitsRetired != 1 {
		t.Errorf("PhysicalUnitsRetired = %d, want 1", fleet.PhysicalUnitsRetired)
	}
	if len(fleet.UnknownModels) != 1 {
		t.Errorf("len(UnknownModels) = %d, want 1", len(fleet.UnknownModels))
	}
}

func TestCalcFleetSavings_EmptyFleet(t *testing.T) {
	fleet := CalcFleetSavings([]MemberSavings{})
	if fleet.MemberCount != 0 {
		t.Errorf("MemberCount = %d, want 0", fleet.MemberCount)
	}
	if fleet.TotalDeltaVCPU != 0 || fleet.TotalDeltaRamGB != 0 {
		t.Errorf("totals not zero: %d/%v", fleet.TotalDeltaVCPU, fleet.TotalDeltaRamGB)
	}
	if fleet.UnknownModels == nil || fleet.InvalidCombinations == nil {
		t.Error("exclusion slices must be non-nil")
	}
	if len(fleet.UnknownModels) != 0 || len(fleet.InvalidCombinations) != 0 {
		t.Error("exclusion slices must be empty")
	}
}

func TestCalcFleetSavings_Invariant(t *testing.T) {
	members := []MemberSavings{
		CalcMemberSavings(MemberSavingsInput{MemberID: "a", MemberName: "a", Model: "IB-V2225", Platform: PlatformVMware}, "2XS", "nios-x", -1),
		CalcMemberSavings(MemberSavingsInput{MemberID: "b", MemberName: "b", Model: "IB-V2326", Platform: PlatformVMware}, "", "nios-xaas", -1),
		CalcMemberSavings(MemberSavingsInput{MemberID: "c", MemberName: "c", Model: "IB-V1526", Platform: PlatformVMware}, "M", "nios-x", -1),
	}
	fleet := CalcFleetSavings(members)
	sum := fleet.NiosXSavings.VCPU + fleet.XaasSavings.VCPU
	if sum != fleet.TotalDeltaVCPU {
		t.Errorf("NiosX.VCPU(%d) + Xaas.VCPU(%d) = %d, want TotalDeltaVCPU=%d",
			fleet.NiosXSavings.VCPU, fleet.XaasSavings.VCPU, sum, fleet.TotalDeltaVCPU)
	}
	sumRam := fleet.NiosXSavings.RamGB + fleet.XaasSavings.RamGB
	if sumRam != fleet.TotalDeltaRamGB {
		t.Errorf("NiosX.RamGB(%v) + Xaas.RamGB(%v) = %v, want TotalDeltaRamGB=%v",
			fleet.NiosXSavings.RamGB, fleet.XaasSavings.RamGB, sumRam, fleet.TotalDeltaRamGB)
	}
}

func TestCalcFleetSavings_InvalidCombinations(t *testing.T) {
	members := []MemberSavings{
		CalcMemberSavings(
			MemberSavingsInput{MemberID: "x", MemberName: "x", Model: "IB-V2215", Platform: PlatformAzure},
			"2XS", "nios-x", -1,
		),
	}
	fleet := CalcFleetSavings(members)
	if len(fleet.InvalidCombinations) != 1 {
		t.Fatalf("len(InvalidCombinations) = %d, want 1", len(fleet.InvalidCombinations))
	}
	want := InvalidCombination{Model: "IB-V2215", Platform: "Azure"}
	if fleet.InvalidCombinations[0] != want {
		t.Errorf("InvalidCombinations[0] = %+v, want %+v", fleet.InvalidCombinations[0], want)
	}
	// Excluded → not counted in totals.
	if fleet.NiosXSavings.MemberCount != 0 {
		t.Errorf("excluded member counted in NiosX: %d", fleet.NiosXSavings.MemberCount)
	}
}

// ─────────────────────── Canonical JSON / SHA256 tests (Task 2) ───────────────────────

func TestCanonicalVNIOSSpecsJSON_Stable(t *testing.T) {
	a := CanonicalVNIOSSpecsJSON()
	b := CanonicalVNIOSSpecsJSON()
	if string(a) != string(b) {
		t.Error("CanonicalVNIOSSpecsJSON not stable across calls")
	}
}

func TestCanonicalVNIOSSpecsJSON_KeysSorted(t *testing.T) {
	out := string(CanonicalVNIOSSpecsJSON())

	// First spec must open with defaultVariantIndex (alphabetically first key).
	if !strings.HasPrefix(out, `[{"defaultVariantIndex":`) {
		t.Errorf("output does not start with [{\"defaultVariantIndex\": — got %.80s", out)
	}

	// Spec keys must appear in this order in every spec object:
	// defaultVariantIndex, generation, model, platform, variants, vmwareOnly
	specKeys := []string{`"defaultVariantIndex"`, `"generation"`, `"model"`, `"platform"`, `"variants"`}
	lastIdx := -1
	for _, k := range specKeys {
		idx := strings.Index(out, k)
		if idx == -1 {
			t.Errorf("key %s not found in output", k)
			continue
		}
		if idx <= lastIdx {
			t.Errorf("key %s appears at %d, before previous key (last=%d)", k, idx, lastIdx)
		}
		lastIdx = idx
	}

	// Variant keys: configName must precede ramGB and vCPU in the first variant.
	// Check the first variant of the first spec.
	cfgIdx := strings.Index(out, `"configName"`)
	ramIdx := strings.Index(out, `"ramGB"`)
	vcpuIdx := strings.Index(out, `"vCPU"`)
	if cfgIdx == -1 || ramIdx == -1 || vcpuIdx == -1 {
		t.Fatal("variant keys missing")
	}
	if !(cfgIdx < ramIdx && ramIdx < vcpuIdx) {
		t.Errorf("variant key order wrong: configName=%d ramGB=%d vCPU=%d",
			cfgIdx, ramIdx, vcpuIdx)
	}

	// vmwareOnly when false must NOT appear; vmwareOnly:true must appear ≥ 3 times.
	if strings.Contains(out, `"vmwareOnly":false`) {
		t.Error("output contains vmwareOnly:false (should be omitted)")
	}
	if got := strings.Count(out, `"vmwareOnly":true`); got != 3 {
		t.Errorf("count of vmwareOnly:true = %d, want 3", got)
	}

	// instanceType empty must NOT appear.
	if strings.Contains(out, `"instanceType":""`) {
		t.Error("output contains instanceType:\"\" (should be omitted)")
	}
}

func TestComputeVNIOSSpecsHash_Format(t *testing.T) {
	h := ComputeVNIOSSpecsHash()
	if len(h) != 64 {
		t.Errorf("hash length = %d, want 64", len(h))
	}
	if _, err := hex.DecodeString(h); err != nil {
		t.Errorf("hash is not valid hex: %v", err)
	}
	if h != strings.ToLower(h) {
		t.Error("hash is not lowercase")
	}
	// Stability
	h2 := ComputeVNIOSSpecsHash()
	if h != h2 {
		t.Error("ComputeVNIOSSpecsHash not stable")
	}
}

// TestCanonicalVNIOSSpecsJSON_NumberFormat ensures float values render without
// trailing zeros (matching JS Number→String coercion in JSON.stringify) and
// integer-valued floats render without a decimal point.
func TestCanonicalVNIOSSpecsJSON_NumberFormat(t *testing.T) {
	out := string(CanonicalVNIOSSpecsJSON())
	// 15.25 (X5 AWS r4 IB-V825) must appear as-is.
	if !strings.Contains(out, `"ramGB":15.25`) {
		t.Error("expected ramGB:15.25 in output (X5 AWS r4 IB-V825)")
	}
	// 30.5 must appear as 30.5 not 30.50.
	if !strings.Contains(out, `"ramGB":30.5`) {
		t.Error("expected ramGB:30.5 in output (X5 AWS r4 IB-V1425)")
	}
	// Integer floats must render as integers (no .0 suffix).
	if strings.Contains(out, `"ramGB":16.0`) || strings.Contains(out, `"ramGB":64.0`) {
		t.Error("integer-valued ramGB rendered with trailing .0 — breaks TS parity")
	}
	if !strings.Contains(out, `"ramGB":16`) {
		t.Error("expected ramGB:16 (no decimal) in output")
	}
}

// TestVNIOSSpecsHashMatchesFile asserts that the committed canonical hash file
// (vnios_specs.sha256) matches the Go-side ComputeVNIOSSpecsHash() output.
//
// If this test fails, the VNIOS_SPECS table has drifted from the committed
// canonical hash. Run `make verify-vnios-specs` for a side-by-side diff against
// the TS-side table, then update vnios_specs.sha256 with the new agreed hash.
func TestVNIOSSpecsHashMatchesFile(t *testing.T) {
	const hashFile = "vnios_specs.sha256"
	raw, err := os.ReadFile(hashFile)
	if err != nil {
		t.Fatalf("read %s: %v", hashFile, err)
	}
	fileHash := strings.TrimSpace(string(raw))
	computed := ComputeVNIOSSpecsHash()
	if fileHash != computed {
		t.Fatalf("VNIOSSpecs hash drift:\n  file=%s (%s)\n  computed=%s\n  run 'make verify-vnios-specs' to investigate", fileHash, hashFile, computed)
	}
}
