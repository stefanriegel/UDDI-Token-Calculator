// vnios_specs.go — Hardcoded vNIOS appliance specification table and resource
// savings calculator for the Migration Planner.
//
// This module mirrors frontend/src/app/components/resource-savings.ts (TS plan
// 26-01) byte-for-byte in canonical JSON form. The SHA256 of CanonicalVNIOSSpecsJSON()
// must equal the TS computeVnioSpecsHash() output. Plan 26-03 wires the parity
// check via vnios_specs.sha256.
//
// Source of truth for the data table: docs/superpowers/specs/2026-04-07-resource-savings-design.md §4
// (vNIOS X5/X6 specs captured 2026-04-07 from docs.infoblox.com).
//
// Pure computation, no I/O. Imported by internal/exporter/exporter.go (Phase 28).
package calculator

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
)

// ApplianceGeneration enumerates vNIOS hardware generations.
type ApplianceGeneration string

const (
	GenerationX5       ApplianceGeneration = "X5"
	GenerationX6       ApplianceGeneration = "X6"
	GenerationPhysical ApplianceGeneration = "Physical"
)

// AppliancePlatform enumerates the deployment platforms a vNIOS spec row applies to.
type AppliancePlatform string

const (
	PlatformVMware   AppliancePlatform = "VMware"
	PlatformAzure    AppliancePlatform = "Azure"
	PlatformAWS      AppliancePlatform = "AWS"
	PlatformGCP      AppliancePlatform = "GCP"
	PlatformPhysical AppliancePlatform = "Physical"
)

// ApplianceVariant is a single (vCPU, RAM) sizing option for an appliance spec.
// Some appliances expose multiple variants (e.g. AWS r6i/m5/r4, X6 Small/Large).
type ApplianceVariant struct {
	ConfigName      string  `json:"configName"`
	VCPU            int     `json:"vCPU"`
	RamGB           float64 `json:"ramGB"`
	InstanceType    string  `json:"instanceType,omitempty"`
	InstanceTypeAlt string  `json:"instanceTypeAlt,omitempty"`
}

// ApplianceSpec is one row in the VNIOSSpecs lookup table.
type ApplianceSpec struct {
	Model               string              `json:"model"`
	Generation          ApplianceGeneration `json:"generation"`
	Platform            AppliancePlatform   `json:"platform"`
	Variants            []ApplianceVariant  `json:"variants"`
	DefaultVariantIndex int                 `json:"defaultVariantIndex"`
	VmwareOnly          bool                `json:"vmwareOnly,omitempty"`
}

// MemberSavingsInput is the per-member input shape for CalcMemberSavings.
type MemberSavingsInput struct {
	MemberID   string
	MemberName string
	Model      string
	Platform   AppliancePlatform
}

// MemberSavings is the per-member resource savings output. Negative deltas
// indicate savings; positive deltas (regressions) are still reported and
// counted in fleet totals as anti-savings.
type MemberSavings struct {
	MemberID                string              `json:"memberId"`
	MemberName              string              `json:"memberName"`
	OldModel                string              `json:"oldModel"`
	OldPlatform             AppliancePlatform   `json:"oldPlatform"`
	OldGeneration           ApplianceGeneration `json:"oldGeneration"`
	OldVariantIndex         int                 `json:"oldVariantIndex"`
	OldVCPU                 int                 `json:"oldVCPU"`
	OldRamGB                float64             `json:"oldRamGB"`
	TargetFormFactor        string              `json:"targetFormFactor"` // "nios-x" or "nios-xaas"
	NewTierName             string              `json:"newTierName"`
	NewVCPU                 int                 `json:"newVCPU"`
	NewRamGB                float64             `json:"newRamGB"`
	DeltaVCPU               int                 `json:"deltaVCPU"`
	DeltaRamGB              float64             `json:"deltaRamGB"`
	PhysicalDecommission    bool                `json:"physicalDecommission"`
	FullyManaged            bool                `json:"fullyManaged"`
	LookupMissing           bool                `json:"lookupMissing"`
	InvalidPlatformForModel bool                `json:"invalidPlatformForModel"`
}

// FleetSubtotal is a per-form-factor sub-total inside FleetSavings.
type FleetSubtotal struct {
	VCPU        int     `json:"vCPU"`
	RamGB       float64 `json:"ramGB"`
	MemberCount int     `json:"memberCount"`
}

// InvalidCombination records a (model, platform) pair that was excluded from
// fleet totals because the model is VMware-only and was deployed on a cloud.
type InvalidCombination struct {
	Model    string `json:"model"`
	Platform string `json:"platform"`
}

// FleetSavings aggregates resource savings across a fleet of members.
type FleetSavings struct {
	MemberCount          int                  `json:"memberCount"`
	TotalOldVCPU         int                  `json:"totalOldVCPU"`
	TotalOldRamGB        float64              `json:"totalOldRamGB"`
	TotalNewVCPU         int                  `json:"totalNewVCPU"`
	TotalNewRamGB        float64              `json:"totalNewRamGB"`
	TotalDeltaVCPU       int                  `json:"totalDeltaVCPU"`
	TotalDeltaRamGB      float64              `json:"totalDeltaRamGB"`
	NiosXSavings         FleetSubtotal        `json:"niosXSavings"`
	XaasSavings          FleetSubtotal        `json:"xaasSavings"`
	PhysicalUnitsRetired int                  `json:"physicalUnitsRetired"`
	UnknownModels        []string             `json:"unknownModels"`
	InvalidCombinations  []InvalidCombination `json:"invalidCombinations"`
}

// niosXTierMinima maps NIOS-X tier name → (vCPU, ramGB) for the savings "after" side.
// Source: frontend/src/app/components/nios-calc.ts SERVER_TOKEN_TIERS (Phase 11).
// TODO(phase-26): consolidate with any future Go SERVER_TOKEN_TIERS table if added.
var niosXTierMinima = map[string]struct {
	VCPU  int
	RamGB float64
}{
	"2XS": {3, 4},
	"XS":  {3, 4},
	"S":   {4, 4},
	"M":   {4, 32},
	"L":   {16, 32},
	"XL":  {24, 32},
}

// VNIOSSpecs is the hardcoded vNIOS appliance specification table.
// Mirrors VNIOS_SPECS in frontend/src/app/components/resource-savings.ts byte-for-byte
// in canonical JSON form (verified by SHA256 parity check in plan 26-03).
//
// Source: docs/superpowers/specs/2026-04-07-resource-savings-design.md §4
// (captured 2026-04-07 from docs.infoblox.com vNIOS spec pages).
var VNIOSSpecs = []ApplianceSpec{
	// ─── X5 / VMware (8 models, 1 variant each) ───
	{
		Model:               "IB-V815",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 2, RamGB: 16}},
		DefaultVariantIndex: 0,
		VmwareOnly:          true,
	},
	{
		Model:               "IB-V825",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 2, RamGB: 16}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V1415",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 4, RamGB: 32}},
		DefaultVariantIndex: 0,
		VmwareOnly:          true,
	},
	{
		Model:               "IB-V1425",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 4, RamGB: 32}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V2215",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 8, RamGB: 64}},
		DefaultVariantIndex: 0,
		VmwareOnly:          true,
	},
	{
		Model:               "IB-V2225",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 8, RamGB: 64}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4015",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 14, RamGB: 128}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4025",
		Generation:          GenerationX5,
		Platform:            PlatformVMware,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 14, RamGB: 128}},
		DefaultVariantIndex: 0,
	},

	// ─── X5 / Azure (5 models, 1 variant each) ───
	{
		Model:               "IB-V825",
		Generation:          GenerationX5,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 2, RamGB: 14, InstanceType: "Standard DS11 v2"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V1425",
		Generation:          GenerationX5,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 4, RamGB: 28, InstanceType: "Standard DS12 v2"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V2225",
		Generation:          GenerationX5,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 8, RamGB: 56, InstanceType: "Standard DS13 v2"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4015",
		Generation:          GenerationX5,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 16, RamGB: 112, InstanceType: "Standard DS14_v2"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4025",
		Generation:          GenerationX5,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 16, RamGB: 112, InstanceType: "Standard DS14_v2"}},
		DefaultVariantIndex: 0,
	},

	// ─── X5 / AWS (5 models, 3 variants each: r6i default, m5, r4) ───
	{
		Model:      "IB-V825",
		Generation: GenerationX5,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "r6i", VCPU: 2, RamGB: 16, InstanceType: "r6i.large", InstanceTypeAlt: "r6i.large"},
			{ConfigName: "m5", VCPU: 2, RamGB: 8, InstanceType: "m5.large", InstanceTypeAlt: "m5.large"},
			{ConfigName: "r4", VCPU: 2, RamGB: 15.25, InstanceType: "r4.large", InstanceTypeAlt: "i3.large"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1425",
		Generation: GenerationX5,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "r6i", VCPU: 4, RamGB: 32, InstanceType: "r6i.xlarge", InstanceTypeAlt: "r6i.xlarge"},
			{ConfigName: "m5", VCPU: 4, RamGB: 16, InstanceType: "m5.xlarge", InstanceTypeAlt: "m5.xlarge"},
			{ConfigName: "r4", VCPU: 4, RamGB: 30.5, InstanceType: "r4.xlarge", InstanceTypeAlt: "d2.xlarge / i3.xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V2225",
		Generation: GenerationX5,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "r6i", VCPU: 8, RamGB: 64, InstanceType: "r6i.2xlarge", InstanceTypeAlt: "r6i.2xlarge"},
			{ConfigName: "m5", VCPU: 8, RamGB: 32, InstanceType: "m5.2xlarge", InstanceTypeAlt: "m5.2xlarge"},
			{ConfigName: "r4", VCPU: 8, RamGB: 61, InstanceType: "r4.2xlarge", InstanceTypeAlt: "d2.2xlarge / i3.2xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V4015",
		Generation: GenerationX5,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "r6i", VCPU: 16, RamGB: 128, InstanceType: "r6i.4xlarge", InstanceTypeAlt: "r6i.4xlarge"},
			{ConfigName: "m5", VCPU: 16, RamGB: 64, InstanceType: "m5.4xlarge", InstanceTypeAlt: "m5.4xlarge"},
			{ConfigName: "r4", VCPU: 16, RamGB: 122, InstanceType: "r4.4xlarge", InstanceTypeAlt: "d2.4xlarge / i3.4xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V4025",
		Generation: GenerationX5,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "r6i", VCPU: 16, RamGB: 128, InstanceType: "r6i.4xlarge", InstanceTypeAlt: "r6i.4xlarge"},
			{ConfigName: "m5", VCPU: 16, RamGB: 64, InstanceType: "m5.4xlarge", InstanceTypeAlt: "m5.4xlarge"},
			{ConfigName: "r4", VCPU: 16, RamGB: 122, InstanceType: "r4.4xlarge", InstanceTypeAlt: "d2.4xlarge / i3.4xlarge"},
		},
		DefaultVariantIndex: 0,
	},

	// ─── X5 / GCP (5 models, 1 variant each) ───
	{
		Model:               "IB-V825",
		Generation:          GenerationX5,
		Platform:            PlatformGCP,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 2, RamGB: 16, InstanceType: "n1-highmem-2"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V1425",
		Generation:          GenerationX5,
		Platform:            PlatformGCP,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 4, RamGB: 32, InstanceType: "n1-highmem-4"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V2225",
		Generation:          GenerationX5,
		Platform:            PlatformGCP,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 8, RamGB: 64, InstanceType: "n1-highmem-8"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4015",
		Generation:          GenerationX5,
		Platform:            PlatformGCP,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 16, RamGB: 128, InstanceType: "n1-highmem-16"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4025",
		Generation:          GenerationX5,
		Platform:            PlatformGCP,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 16, RamGB: 128, InstanceType: "n1-highmem-16"}},
		DefaultVariantIndex: 0,
	},

	// ─── X6 / VMware (5 models, 2 variants each) ───
	{
		Model:      "IB-V926",
		Generation: GenerationX6,
		Platform:   PlatformVMware,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 4, RamGB: 32},
			{ConfigName: "Large", VCPU: 8, RamGB: 32},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1516",
		Generation: GenerationX6,
		Platform:   PlatformVMware,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 6, RamGB: 64},
			{ConfigName: "Large", VCPU: 12, RamGB: 64},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1526",
		Generation: GenerationX6,
		Platform:   PlatformVMware,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 8, RamGB: 64},
			{ConfigName: "Large", VCPU: 16, RamGB: 64},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V2326",
		Generation: GenerationX6,
		Platform:   PlatformVMware,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 12, RamGB: 128},
			{ConfigName: "Large", VCPU: 20, RamGB: 192},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V4126",
		Generation: GenerationX6,
		Platform:   PlatformVMware,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 16, RamGB: 256},
			{ConfigName: "Large", VCPU: 32, RamGB: 384},
		},
		DefaultVariantIndex: 0,
	},

	// ─── X6 / Azure (5 models, 1 variant each, v3+v5 sizing in instanceType) ───
	{
		Model:               "IB-V926",
		Generation:          GenerationX6,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 4, RamGB: 32, InstanceType: "Standard_E4s_v3 / Standard_E4s_v5"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V1516",
		Generation:          GenerationX6,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 8, RamGB: 64, InstanceType: "Standard_E8s_v3 / Standard_E8s_v5"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V1526",
		Generation:          GenerationX6,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 16, RamGB: 128, InstanceType: "Standard_E16s_v3 / Standard_E16s_v5"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V2326",
		Generation:          GenerationX6,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 20, RamGB: 160, InstanceType: "Standard_E20s_v3 / Standard_E20s_v5"}},
		DefaultVariantIndex: 0,
	},
	{
		Model:               "IB-V4126",
		Generation:          GenerationX6,
		Platform:            PlatformAzure,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 32, RamGB: 256, InstanceType: "Standard_E32s_v3 / Standard_E32s_v5"}},
		DefaultVariantIndex: 0,
	},

	// ─── X6 / AWS (5 models, 2 variants each) ───
	{
		Model:      "IB-V926",
		Generation: GenerationX6,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 4, RamGB: 32, InstanceType: "r6i.xlarge / r7i.xlarge"},
			{ConfigName: "Large", VCPU: 8, RamGB: 32, InstanceType: "m6i.2xlarge / m7i.2xlarge", InstanceTypeAlt: "m5.2xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1516",
		Generation: GenerationX6,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 8, RamGB: 64, InstanceType: "r6i.2xlarge / r7i.2xlarge"},
			{ConfigName: "Large", VCPU: 16, RamGB: 64, InstanceType: "m6i.4xlarge / m7i.4xlarge", InstanceTypeAlt: "m5.4xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1526",
		Generation: GenerationX6,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 16, RamGB: 64, InstanceType: "m6i.4xlarge / m7i.4xlarge"},
			{ConfigName: "Large", VCPU: 16, RamGB: 128, InstanceType: "r6i.4xlarge / r7i.4xlarge", InstanceTypeAlt: "r5d.4xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V2326",
		Generation: GenerationX6,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 32, RamGB: 128, InstanceType: "m6i.8xlarge / m7i.8xlarge"},
			{ConfigName: "Large", VCPU: 32, RamGB: 256, InstanceType: "r6i.8xlarge / r7i.8xlarge", InstanceTypeAlt: "r5d.8xlarge"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V4126",
		Generation: GenerationX6,
		Platform:   PlatformAWS,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 32, RamGB: 256, InstanceType: "r6i.8xlarge / r7i.8xlarge"},
			{ConfigName: "Large", VCPU: 48, RamGB: 384, InstanceType: "r6i.12xlarge / r7i.12xlarge", InstanceTypeAlt: "r5d.12xlarge"},
		},
		DefaultVariantIndex: 0,
	},

	// ─── X6 / GCP (5 models, 3 variants each) ───
	{
		Model:      "IB-V926",
		Generation: GenerationX6,
		Platform:   PlatformGCP,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 8, RamGB: 16, InstanceType: "n4-highcpu-8"},
			{ConfigName: "Medium", VCPU: 8, RamGB: 32, InstanceType: "n4-standard-8"},
			{ConfigName: "Large", VCPU: 8, RamGB: 64, InstanceType: "n4-highmem-8"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1516",
		Generation: GenerationX6,
		Platform:   PlatformGCP,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 16, RamGB: 32, InstanceType: "n4-highcpu-16"},
			{ConfigName: "Medium", VCPU: 16, RamGB: 64, InstanceType: "n4-standard-16"},
			{ConfigName: "Large", VCPU: 16, RamGB: 128, InstanceType: "n4-highmem-16"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V1526",
		Generation: GenerationX6,
		Platform:   PlatformGCP,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 16, RamGB: 64, InstanceType: "n4-standard-16"},
			{ConfigName: "Medium", VCPU: 16, RamGB: 128, InstanceType: "n4-highmem-16"},
			{ConfigName: "Large", VCPU: 32, RamGB: 64, InstanceType: "n4-highcpu-32"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V2326",
		Generation: GenerationX6,
		Platform:   PlatformGCP,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 32, RamGB: 64, InstanceType: "n4-highcpu-32"},
			{ConfigName: "Medium", VCPU: 32, RamGB: 128, InstanceType: "n4-standard-32"},
			{ConfigName: "Large", VCPU: 32, RamGB: 256, InstanceType: "n4-highmem-32"},
		},
		DefaultVariantIndex: 0,
	},
	{
		Model:      "IB-V4126",
		Generation: GenerationX6,
		Platform:   PlatformGCP,
		Variants: []ApplianceVariant{
			{ConfigName: "Small", VCPU: 64, RamGB: 512, InstanceType: "n4-standard-64"},
			{ConfigName: "Medium", VCPU: 80, RamGB: 160, InstanceType: "n4-standard-80"},
			{ConfigName: "Large", VCPU: 80, RamGB: 320, InstanceType: "n4-standard-80"},
		},
		DefaultVariantIndex: 0,
	},

	// ─── Physical chassis ───
	// TODO: verify IB-4030 specs against Trinzic datasheet (placeholder values).
	{
		Model:               "IB-4030",
		Generation:          GenerationPhysical,
		Platform:            PlatformPhysical,
		Variants:            []ApplianceVariant{{ConfigName: "Standard", VCPU: 8, RamGB: 32}},
		DefaultVariantIndex: 0,
	},
}

// LookupApplianceSpec returns the ApplianceSpec for an exact (model, platform)
// match. Returns the zero value and false on miss.
//
// Linear scan — VNIOSSpecs is small (<50 rows) so a map index would be premature
// optimization at the cost of test readability.
func LookupApplianceSpec(model string, platform AppliancePlatform) (ApplianceSpec, bool) {
	for _, spec := range VNIOSSpecs {
		if spec.Model == model && spec.Platform == platform {
			return spec, true
		}
	}
	return ApplianceSpec{}, false
}

// modelExistsOnAnyPlatform reports whether VNIOSSpecs contains any row with the
// given model on a different platform. Used by CalcMemberSavings to distinguish
// "unknown model" from "VMware-only model on cloud".
func modelExistsOnAnyPlatform(model string) bool {
	for _, spec := range VNIOSSpecs {
		if spec.Model == model {
			return true
		}
	}
	return false
}

// CalcMemberSavings computes the per-member resource savings for a single
// member migrating to a target NIOS-X tier or NIOS-XaaS.
//
// formFactor must be "nios-x" or "nios-xaas".
// variantIdx is the user-selected variant index for the OLD appliance; pass -1
// to use the spec's DefaultVariantIndex (Go has no Optional<int>; -1 is the
// sentinel mirroring TS's `variantIdx?: number` undefined-default).
//
// On lookup miss or invalid platform combination the returned MemberSavings
// has zero deltas and the appropriate flag set; CalcFleetSavings excludes such
// members from totals and lists them in the exclusion arrays.
func CalcMemberSavings(input MemberSavingsInput, tierName string, formFactor string, variantIdx int) MemberSavings {
	out := MemberSavings{
		MemberID:         input.MemberID,
		MemberName:       input.MemberName,
		OldModel:         input.Model,
		OldPlatform:      input.Platform,
		TargetFormFactor: formFactor,
		NewTierName:      tierName,
	}

	// Empty model → silent exclusion (no warning).
	if input.Model == "" {
		out.LookupMissing = true
		return out
	}

	spec, ok := LookupApplianceSpec(input.Model, input.Platform)
	if !ok {
		// Distinguish unknown-model from invalid-platform-for-known-model.
		if modelExistsOnAnyPlatform(input.Model) {
			out.InvalidPlatformForModel = true
		} else {
			out.LookupMissing = true
		}
		return out
	}

	// Resolve variant index. -1 sentinel or out-of-range → default.
	vIdx := variantIdx
	if vIdx < 0 || vIdx >= len(spec.Variants) {
		vIdx = spec.DefaultVariantIndex
	}
	variant := spec.Variants[vIdx]

	out.OldGeneration = spec.Generation
	out.OldVariantIndex = vIdx
	out.OldVCPU = variant.VCPU
	out.OldRamGB = variant.RamGB

	// Resolve "after" side based on form factor.
	if formFactor == "nios-xaas" {
		out.NewVCPU = 0
		out.NewRamGB = 0
		out.FullyManaged = true
	} else {
		// nios-x — look up tier minima. Defensive: leave zeros if tier unknown.
		if minima, found := niosXTierMinima[tierName]; found {
			out.NewVCPU = minima.VCPU
			out.NewRamGB = minima.RamGB
		}
	}

	out.DeltaVCPU = out.NewVCPU - out.OldVCPU
	out.DeltaRamGB = out.NewRamGB - out.OldRamGB
	out.PhysicalDecommission = (spec.Generation == GenerationPhysical)

	return out
}

// CalcFleetSavings aggregates MemberSavings into FleetSavings totals with
// separate sub-totals for NIOS-X vs NIOS-XaaS members and exclusion lists for
// unknown models and invalid (model, platform) combinations.
//
// Empty fleet returns zero values, not NaN. Excluded members (LookupMissing or
// InvalidPlatformForModel) are NOT counted in the numeric totals but ARE
// included in MemberCount (which equals len(members)).
func CalcFleetSavings(members []MemberSavings) FleetSavings {
	fleet := FleetSavings{
		MemberCount:         len(members),
		UnknownModels:       []string{},
		InvalidCombinations: []InvalidCombination{},
	}

	for _, m := range members {
		if m.LookupMissing {
			label := m.OldModel
			if label == "" {
				label = m.MemberName
			}
			fleet.UnknownModels = append(fleet.UnknownModels, label)
			continue
		}
		if m.InvalidPlatformForModel {
			fleet.InvalidCombinations = append(fleet.InvalidCombinations, InvalidCombination{
				Model:    m.OldModel,
				Platform: string(m.OldPlatform),
			})
			continue
		}

		fleet.TotalOldVCPU += m.OldVCPU
		fleet.TotalOldRamGB += m.OldRamGB
		fleet.TotalNewVCPU += m.NewVCPU
		fleet.TotalNewRamGB += m.NewRamGB
		fleet.TotalDeltaVCPU += m.DeltaVCPU
		fleet.TotalDeltaRamGB += m.DeltaRamGB

		if m.PhysicalDecommission {
			fleet.PhysicalUnitsRetired++
		}

		if m.FullyManaged {
			fleet.XaasSavings.VCPU += m.DeltaVCPU
			fleet.XaasSavings.RamGB += m.DeltaRamGB
			fleet.XaasSavings.MemberCount++
		} else {
			fleet.NiosXSavings.VCPU += m.DeltaVCPU
			fleet.NiosXSavings.RamGB += m.DeltaRamGB
			fleet.NiosXSavings.MemberCount++
		}
	}

	return fleet
}

// CanonicalVNIOSSpecsJSON serializes VNIOSSpecs to a deterministic JSON byte
// slice with fixed (case-insensitive alphabetical) key ordering and no
// whitespace. Must produce byte-identical output to the TS canonicalVnioSpecsJSON
// in frontend/src/app/components/resource-savings.ts.
//
// Spec key order:    defaultVariantIndex, generation, model, platform, variants, vmwareOnly
// Variant key order: configName, instanceType, instanceTypeAlt, ramGB, vCPU
//
// Optional fields (vmwareOnly when false, instanceType/instanceTypeAlt when "")
// are omitted entirely — never written as null.
//
// Numbers are formatted via strconv.FormatFloat with -1 precision (matching
// JavaScript's Number→String coercion in JSON.stringify): no trailing zeros,
// no scientific notation. Integers stored in float64 fields render without a
// decimal point (e.g. 16, not 16.0).
func CanonicalVNIOSSpecsJSON() []byte {
	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, spec := range VNIOSSpecs {
		if i > 0 {
			buf.WriteByte(',')
		}
		writeSpec(&buf, spec)
	}
	buf.WriteByte(']')
	return buf.Bytes()
}

func writeSpec(buf *bytes.Buffer, spec ApplianceSpec) {
	buf.WriteByte('{')
	// defaultVariantIndex
	buf.WriteString(`"defaultVariantIndex":`)
	buf.WriteString(strconv.Itoa(spec.DefaultVariantIndex))
	// generation
	buf.WriteString(`,"generation":`)
	writeJSONString(buf, string(spec.Generation))
	// model
	buf.WriteString(`,"model":`)
	writeJSONString(buf, spec.Model)
	// platform
	buf.WriteString(`,"platform":`)
	writeJSONString(buf, string(spec.Platform))
	// variants
	buf.WriteString(`,"variants":[`)
	for i, v := range spec.Variants {
		if i > 0 {
			buf.WriteByte(',')
		}
		writeVariant(buf, v)
	}
	buf.WriteByte(']')
	// vmwareOnly (only when true)
	if spec.VmwareOnly {
		buf.WriteString(`,"vmwareOnly":true`)
	}
	buf.WriteByte('}')
}

func writeVariant(buf *bytes.Buffer, v ApplianceVariant) {
	buf.WriteByte('{')
	// configName
	buf.WriteString(`"configName":`)
	writeJSONString(buf, v.ConfigName)
	// instanceType (only when non-empty)
	if v.InstanceType != "" {
		buf.WriteString(`,"instanceType":`)
		writeJSONString(buf, v.InstanceType)
	}
	// instanceTypeAlt (only when non-empty)
	if v.InstanceTypeAlt != "" {
		buf.WriteString(`,"instanceTypeAlt":`)
		writeJSONString(buf, v.InstanceTypeAlt)
	}
	// ramGB
	buf.WriteString(`,"ramGB":`)
	buf.WriteString(strconv.FormatFloat(v.RamGB, 'f', -1, 64))
	// vCPU
	buf.WriteString(`,"vCPU":`)
	buf.WriteString(strconv.Itoa(v.VCPU))
	buf.WriteByte('}')
}

// writeJSONString writes a JSON-escaped string literal (with surrounding quotes)
// to buf. Matches JSON.stringify escape behavior for the strings present in
// VNIOSSpecs (alphanumerics, spaces, dots, slashes, hyphens, underscores).
func writeJSONString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if c < 0x20 {
				// Control char — emit \u00XX.
				buf.WriteString(`\u00`)
				const hexdigits = "0123456789abcdef"
				buf.WriteByte(hexdigits[c>>4])
				buf.WriteByte(hexdigits[c&0xF])
			} else {
				buf.WriteByte(c)
			}
		}
	}
	buf.WriteByte('"')
}

// ComputeVNIOSSpecsHash returns the SHA256 hash of CanonicalVNIOSSpecsJSON()
// as a 64-character lowercase hex string. The TS side must produce the same
// hash for the same logical data — plan 26-03 enforces parity via vnios_specs.sha256.
func ComputeVNIOSSpecsHash() string {
	sum := sha256.Sum256(CanonicalVNIOSSpecsJSON())
	return hex.EncodeToString(sum[:])
}
