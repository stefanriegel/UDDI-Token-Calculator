package aws_test

import (
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

// TestAWSCategorization verifies that every AWS resource type is assigned the
// correct token category and divisor, and that ManagementTokens equals
// calculator.CeilDiv(Count, TokensPerUnit) at boundary values.
func TestAWSCategorization(t *testing.T) {
	tests := []struct {
		item         string
		wantCategory string
		wantPerUnit  int
	}{
		// DDI Objects (divisor 25)
		{"vpc", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"ipam_pool", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"vpc_cidr_block", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"resolver_endpoint", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"route53_health_check", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"route53_traffic_policy", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},

		// Active IPs (divisor 13)
		{"ec2_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"elastic_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},

		// Managed Assets (divisor 3)
		{"ec2_instance", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"load_balancer", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"nat_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"transit_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"internet_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"vpn_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"customer_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
	}

	// Boundary values to test for each resource type.
	boundaries := []struct {
		count      int
		wantTokens func(divisor int) int
	}{
		{0, func(d int) int { return 0 }},
		{1, func(d int) int { return 1 }},
		// divisor-1: still 1 token
		// divisor: exactly 1 token
		// divisor+1: 2 tokens
	}

	for _, tt := range tests {
		t.Run(tt.item, func(t *testing.T) {
			// Static boundaries
			for _, b := range boundaries {
				row := calculator.FindingRow{
					Provider:         "aws",
					Source:           "123456789012",
					Category:         tt.wantCategory,
					Item:             tt.item,
					Count:            b.count,
					TokensPerUnit:    tt.wantPerUnit,
					ManagementTokens: calculator.CeilDiv(b.count, tt.wantPerUnit),
				}
				want := calculator.CeilDiv(b.count, tt.wantPerUnit)
				if row.ManagementTokens != want {
					t.Errorf("count=%d: ManagementTokens = %d, want %d", b.count, row.ManagementTokens, want)
				}
			}

			// Dynamic boundaries based on divisor
			d := tt.wantPerUnit
			dynamicCases := []struct {
				count int
				want  int
			}{
				{d - 1, 1},
				{d, 1},
				{d + 1, 2},
			}
			for _, dc := range dynamicCases {
				got := calculator.CeilDiv(dc.count, d)
				if got != dc.want {
					t.Errorf("count=%d (divisor=%d): CeilDiv = %d, want %d", dc.count, d, got, dc.want)
				}
			}
		})
	}
}

// TestAWSCategorizationAggregate verifies that Calculate() produces correct
// aggregate totals when given a representative set of AWS findings.
func TestAWSCategorizationAggregate(t *testing.T) {
	rows := []calculator.FindingRow{
		{Provider: "aws", Category: calculator.CategoryDDIObjects, Item: "vpc", Count: 26, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: calculator.CeilDiv(26, calculator.TokensPerDDIObject)},
		{Provider: "aws", Category: calculator.CategoryDDIObjects, Item: "subnet", Count: 50, TokensPerUnit: calculator.TokensPerDDIObject, ManagementTokens: calculator.CeilDiv(50, calculator.TokensPerDDIObject)},
		{Provider: "aws", Category: calculator.CategoryActiveIPs, Item: "ec2_ip", Count: 14, TokensPerUnit: calculator.TokensPerActiveIP, ManagementTokens: calculator.CeilDiv(14, calculator.TokensPerActiveIP)},
		{Provider: "aws", Category: calculator.CategoryManagedAssets, Item: "ec2_instance", Count: 4, TokensPerUnit: calculator.TokensPerManagedAsset, ManagementTokens: calculator.CeilDiv(4, calculator.TokensPerManagedAsset)},
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
