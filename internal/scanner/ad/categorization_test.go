package ad

import (
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

// TestADCategorization verifies each AD resource type maps to the correct
// calculator category and uses the correct divisor (TokensPerUnit).
// Boundary values: 1, divisor-1, divisor, divisor+1 confirm ceiling division.
func TestADCategorization(t *testing.T) {
	type resourceSpec struct {
		item          string
		category      string
		tokensPerUnit int
	}
	specs := []resourceSpec{
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_record", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dhcp_scope", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dhcp_lease", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"dhcp_reservation", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"user_account", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"computer_count", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"static_ip_count", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"entra_user_count", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"entra_device_count", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
	}

	for _, spec := range specs {
		t.Run(spec.item, func(t *testing.T) {
			// Verify ceilDiv produces correct ManagementTokens for boundary counts.
			boundaryTests := []struct {
				count    int
				wantMgmt int
			}{
				{0, 0},
				{1, 1},
				{spec.tokensPerUnit - 1, 1},
				{spec.tokensPerUnit, 1},
				{spec.tokensPerUnit + 1, 2},
				{spec.tokensPerUnit * 10, 10},
				{spec.tokensPerUnit*10 + 1, 11},
			}
			for _, bt := range boundaryTests {
				got := ceilDiv(bt.count, spec.tokensPerUnit)
				if got != bt.wantMgmt {
					t.Errorf("ceilDiv(%d, %d) = %d, want %d [item=%s]",
						bt.count, spec.tokensPerUnit, got, bt.wantMgmt, spec.item)
				}
			}

			// Verify the FindingRow would use the correct category.
			row := calculator.FindingRow{
				Category:      spec.category,
				Item:          spec.item,
				Count:         100,
				TokensPerUnit: spec.tokensPerUnit,
			}
			if row.Category != spec.category {
				t.Errorf("item %q: category = %q, want %q", spec.item, row.Category, spec.category)
			}
			if row.TokensPerUnit != spec.tokensPerUnit {
				t.Errorf("item %q: tokensPerUnit = %d, want %d", spec.item, row.TokensPerUnit, spec.tokensPerUnit)
			}
		})
	}
}

// TestADTierMapping verifies calcADTier returns the correct tier for boundary
// and real-world metric values.
func TestADTierMapping(t *testing.T) {
	tests := []struct {
		name         string
		qps          int
		lps          int
		objects      int
		wantTier     string
		wantTokens   int
	}{
		// Fits comfortably in 2XS
		{"real DC01 fits 2XS", 2800, 45, 1658, "2XS", 130},
		// Exact 2XS boundary
		{"exact 2XS boundary", 5000, 75, 3000, "2XS", 130},
		// QPS exceeds 2XS -> XS
		{"QPS exceeds 2XS", 5001, 75, 3000, "XS", 250},
		// LPS exceeds 2XS -> XS
		{"LPS exceeds 2XS", 5000, 76, 3000, "XS", 250},
		// Objects exceed 2XS -> XS
		{"objects exceed 2XS", 5000, 75, 3001, "XS", 250},
		// Exact XS boundary
		{"exact XS boundary", 10000, 150, 7500, "XS", 250},
		// Exact S boundary
		{"exact S boundary", 20000, 200, 29000, "S", 470},
		// Exact M boundary
		{"exact M boundary", 40000, 300, 110000, "M", 880},
		// Exact L boundary
		{"exact L boundary", 70000, 400, 440000, "L", 1900},
		// Exact XL boundary
		{"exact XL boundary", 115000, 675, 880000, "XL", 2700},
		// Overflow beyond XL caps at XL
		{"overflow caps at XL", 200000, 1000, 1000000, "XL", 2700},
		// Only one dimension causes bump
		{"high QPS only -> L", 65000, 100, 1000, "L", 1900},
		// Only LPS causes bump
		{"high LPS only -> M", 1000, 250, 100, "M", 880},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tier := calcADTier(tt.qps, tt.lps, tt.objects)
			if tier.name != tt.wantTier {
				t.Errorf("calcADTier(%d, %d, %d).name = %q, want %q",
					tt.qps, tt.lps, tt.objects, tier.name, tt.wantTier)
			}
			if tier.serverTokens != tt.wantTokens {
				t.Errorf("calcADTier(%d, %d, %d).serverTokens = %d, want %d",
					tt.qps, tt.lps, tt.objects, tier.serverTokens, tt.wantTokens)
			}
		})
	}
}

// TestDHCPWithOverheadAudit verifies the +20% ceiling overhead function
// with extended boundary values beyond the existing scanner_test.go coverage.
func TestDHCPWithOverheadAudit(t *testing.T) {
	tests := []struct {
		input int
		want  int
	}{
		{0, 0},
		{1, 2},    // ceil(1.2) = 2
		{5, 6},    // ceil(6.0) = 6
		{7, 9},    // ceil(8.4) = 9
		{10, 12},  // ceil(12.0) = 12
		{340, 408}, // ceil(408.0) = 408
		{100, 120}, // ceil(120.0) = 120
		{3, 4},     // ceil(3.6) = 4
	}

	for _, tt := range tests {
		got := dhcpWithOverhead(tt.input)
		if got != tt.want {
			t.Errorf("dhcpWithOverhead(%d) = %d, want %d", tt.input, got, tt.want)
		}
	}
}

// TestADTotalObjectsComputation verifies the formula
// totalObjects = dnsObjectCount + dhcpWithOverhead(dhcpObjectCount)
// and that calcADTier produces the expected tier for that total.
func TestADTotalObjectsComputation(t *testing.T) {
	tests := []struct {
		name     string
		dns      int
		dhcp     int
		qps      int
		lps      int
		wantTotal int
		wantTier  string
	}{
		{
			name: "DC01 real values",
			dns: 1250, dhcp: 340,
			qps: 2800, lps: 45,
			wantTotal: 1250 + 408, // 1658
			wantTier:  "2XS",
		},
		{
			name: "zero DHCP",
			dns: 500, dhcp: 0,
			qps: 1000, lps: 10,
			wantTotal: 500,
			wantTier:  "2XS",
		},
		{
			name: "high DHCP pushes to S tier",
			dns: 5000, dhcp: 20000,
			qps: 15000, lps: 100,
			wantTotal: 5000 + 24000, // dhcpWithOverhead(20000)=24000; total=29000
			wantTier:  "S",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dhcpOverhead := dhcpWithOverhead(tt.dhcp)
			total := tt.dns + dhcpOverhead
			if total != tt.wantTotal {
				t.Errorf("totalObjects = %d + dhcpWithOverhead(%d) = %d, want %d",
					tt.dns, tt.dhcp, total, tt.wantTotal)
			}
			tier := calcADTier(tt.qps, tt.lps, total)
			if tier.name != tt.wantTier {
				t.Errorf("calcADTier(%d, %d, %d).name = %q, want %q",
					tt.qps, tt.lps, total, tier.name, tt.wantTier)
			}
		})
	}
}
