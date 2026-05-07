package gcp_test

import (
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

// TestGCPCategorization verifies that every GCP resource type is assigned the
// correct token category and divisor, and that ManagementTokens equals
// calculator.CeilDiv(Count, TokensPerUnit) at boundary values.
func TestGCPCategorization(t *testing.T) {
	tests := []struct {
		item         string
		wantCategory string
		wantPerUnit  int
	}{
		// DDI Objects (divisor 25)
		{"vpc_network", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"internal_range", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"gke_cluster_cidr", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"secondary_range", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},

		// Active IPs (divisor 13)
		{"compute_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"compute_address", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},

		// Managed Assets (divisor 3)
		{"compute_instance", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"forwarding_rule", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
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
					Provider:         "gcp",
					Source:           "test-project",
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

// TestGCPCategorizationAggregate verifies Calculate() with representative GCP findings.
func TestGCPCategorizationAggregate(t *testing.T) {
	rows := []calculator.FindingRow{
		{Provider: "gcp", Category: calculator.CategoryDDIObjects, Item: "vpc_network", Count: 26, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: calculator.CeilDiv(26, calculator.TokensPerDDIObject)},
		{Provider: "gcp", Category: calculator.CategoryDDIObjects, Item: "subnet", Count: 50, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: calculator.CeilDiv(50, calculator.TokensPerDDIObject)},
		{Provider: "gcp", Category: calculator.CategoryActiveIPs, Item: "compute_ip", Count: 14, TokensPerUnit: calculator.TokensPerActiveIP, ManagementTokens: calculator.CeilDiv(14, calculator.TokensPerActiveIP)},
		{Provider: "gcp", Category: calculator.CategoryManagedAssets, Item: "compute_instance", Count: 4, TokensPerUnit: calculator.TokensPerManagedAsset, ManagementTokens: calculator.CeilDiv(4, calculator.TokensPerManagedAsset)},
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
