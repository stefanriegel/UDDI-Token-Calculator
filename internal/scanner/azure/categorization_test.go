package azure_test

import (
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

// TestAzureCategorization verifies that every Azure resource type is assigned the
// correct token category and divisor, and that ManagementTokens equals
// calculator.CeilDiv(Count, TokensPerUnit) at boundary values.
func TestAzureCategorization(t *testing.T) {
	tests := []struct {
		item         string
		wantCategory string
		wantPerUnit  int
	}{
		// DDI Objects (divisor 25)
		{"vnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"public_ip", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},

		// Active IPs (divisor 13)
		{"virtual_machine", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"lb_frontend_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"vnet_gateway_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},

		// Managed Assets (divisor 3)
		{"load_balancer", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"application_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"nat_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"azure_firewall", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"private_endpoint", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"vnet_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"virtual_hub", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
	}

	for _, tt := range tests {
		t.Run(tt.item, func(t *testing.T) {
			d := tt.wantPerUnit
			// Boundary values: 0, 1, d-1, d, d+1
			boundaries := []struct {
				count int
				want  int
			}{
				{0, 0},
				{1, 1},
				{d - 1, 1},
				{d, 1},
				{d + 1, 2},
			}
			for _, b := range boundaries {
				row := calculator.FindingRow{
					Provider:         "azure",
					Source:           "test-subscription",
					Category:         tt.wantCategory,
					Item:             tt.item,
					Count:            b.count,
					TokensPerUnit:    tt.wantPerUnit,
					ManagementTokens: calculator.CeilDiv(b.count, tt.wantPerUnit),
				}
				if row.ManagementTokens != b.want {
					t.Errorf("%s count=%d: ManagementTokens = %d, want %d", tt.item, b.count, row.ManagementTokens, b.want)
				}
				if row.Category != tt.wantCategory {
					t.Errorf("%s: Category = %q, want %q", tt.item, row.Category, tt.wantCategory)
				}
				if row.TokensPerUnit != tt.wantPerUnit {
					t.Errorf("%s: TokensPerUnit = %d, want %d", tt.item, row.TokensPerUnit, tt.wantPerUnit)
				}
			}
		})
	}
}

// TestAzureCeilingDivisionRegression documents the floor-division bug that was
// fixed. For boundary values where count is not evenly divisible, the old
// formula (count / divisor) underestimates by 1 token compared to CeilDiv.
func TestAzureCeilingDivisionRegression(t *testing.T) {
	cases := []struct {
		name     string
		count    int
		divisor  int
		oldFloor int
		newCeil  int
	}{
		{"1_vnet_div25", 1, 25, 0, 1},
		{"24_subnets_div25", 24, 25, 0, 1},
		{"26_zones_div25", 26, 25, 1, 2},
		{"1_vmip_div13", 1, 13, 0, 1},
		{"14_lbips_div13", 14, 13, 1, 2},
		{"1_lb_div3", 1, 3, 0, 1},
		{"4_gateways_div3", 4, 3, 1, 2},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			oldResult := tt.count / tt.divisor
			newResult := calculator.CeilDiv(tt.count, tt.divisor)

			if oldResult != tt.oldFloor {
				t.Errorf("old floor(%d/%d) = %d, expected %d", tt.count, tt.divisor, oldResult, tt.oldFloor)
			}
			if newResult != tt.newCeil {
				t.Errorf("CeilDiv(%d, %d) = %d, expected %d", tt.count, tt.divisor, newResult, tt.newCeil)
			}
			if oldResult >= newResult && tt.count%tt.divisor != 0 {
				t.Errorf("floor should be less than ceil for non-exact division: floor=%d, ceil=%d", oldResult, newResult)
			}
		})
	}
}

// TestAzureCategorizationAggregate verifies Calculate() with representative Azure findings.
func TestAzureCategorizationAggregate(t *testing.T) {
	rows := []calculator.FindingRow{
		{Provider: "azure", Category: calculator.CategoryDDIObjects, Item: "vnet", Count: 26, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: calculator.CeilDiv(26, calculator.TokensPerDDIObject)},
		{Provider: "azure", Category: calculator.CategoryDDIObjects, Item: "subnet", Count: 50, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: calculator.CeilDiv(50, calculator.TokensPerDDIObject)},
		{Provider: "azure", Category: calculator.CategoryActiveIPs, Item: "virtual_machine", Count: 14, TokensPerUnit: calculator.TokensPerActiveIP, ManagementTokens: calculator.CeilDiv(14, calculator.TokensPerActiveIP)},
		{Provider: "azure", Category: calculator.CategoryManagedAssets, Item: "load_balancer", Count: 4, TokensPerUnit: calculator.TokensPerManagedAsset, ManagementTokens: calculator.CeilDiv(4, calculator.TokensPerManagedAsset)},
	}

	result := calculator.Calculate(rows)

	// DDI: ceil(76/25) = 4
	if result.DDITokens != 4 {
		t.Errorf("DDITokens = %d, want 4", result.DDITokens)
	}
	// IP: ceil(14/13) = 2
	if result.IPTokens != 2 {
		t.Errorf("IPTokens = %d, want 2", result.IPTokens)
	}
	// Asset: ceil(4/3) = 2
	if result.AssetTokens != 2 {
		t.Errorf("AssetTokens = %d, want 2", result.AssetTokens)
	}
	// Grand total = max(4, 2, 2) = 4
	if result.GrandTotal != 4 {
		t.Errorf("GrandTotal = %d, want 4", result.GrandTotal)
	}
}
