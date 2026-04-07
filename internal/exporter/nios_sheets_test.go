package exporter

import (
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

// niosFindings returns NIOS findings with known values for testing.
// 1000 DDI Objects, 500 Active IPs, 100 Managed Assets.
func niosFindings() []calculator.FindingRow {
	return []calculator.FindingRow{
		{Provider: "nios", Source: "grid01", Category: calculator.CategoryDDIObjects, Item: "dns_zone", Count: 1000, TokensPerUnit: calculator.NIOSTokensPerDDIObject, ManagementTokens: 20},
		{Provider: "nios", Source: "grid01", Category: calculator.CategoryActiveIPs, Item: "active_ip", Count: 500, TokensPerUnit: calculator.NIOSTokensPerActiveIP, ManagementTokens: 20},
		{Provider: "nios", Source: "grid01", Category: calculator.CategoryManagedAssets, Item: "managed_asset", Count: 100, TokensPerUnit: calculator.NIOSTokensPerManagedAsset, ManagementTokens: 8},
	}
}

func TestCalcUddiTokensAggregated(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "nios", Category: calculator.CategoryDDIObjects, Item: "a", Count: 50},
		{Provider: "nios", Category: calculator.CategoryActiveIPs, Item: "b", Count: 26},
		{Provider: "nios", Category: calculator.CategoryManagedAssets, Item: "c", Count: 6},
	}
	// CeilDiv(50,25) + CeilDiv(26,13) + CeilDiv(6,3) = 2+2+2 = 6
	got := calcUddiTokensAggregated(findings)
	if got != 6 {
		t.Errorf("calcUddiTokensAggregated() = %d, want 6", got)
	}
}

func TestCalcNiosTokens(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "nios", Category: calculator.CategoryDDIObjects, Item: "a", Count: 50},
		{Provider: "nios", Category: calculator.CategoryActiveIPs, Item: "b", Count: 26},
		{Provider: "nios", Category: calculator.CategoryManagedAssets, Item: "c", Count: 6},
	}
	// max(CeilDiv(50,50), CeilDiv(26,25), CeilDiv(6,13)) = max(1, 2, 1) = 2
	got := calcNiosTokens(findings)
	if got != 2 {
		t.Errorf("calcNiosTokens() = %d, want 2", got)
	}
}

func TestCalcUddiTokensAggregated_WithGrowthBuffer(t *testing.T) {
	findings := []calculator.FindingRow{
		{Provider: "nios", Category: calculator.CategoryDDIObjects, Item: "a", Count: 50},
		{Provider: "nios", Category: calculator.CategoryActiveIPs, Item: "b", Count: 26},
		{Provider: "nios", Category: calculator.CategoryManagedAssets, Item: "c", Count: 6},
	}
	// Apply 20% growth: 50*1.2=60, 26*1.2=32 (ceil), 6*1.2=8 (ceil)
	buffered := applyGrowthToFindings(findings, 0.20)
	got := calcUddiTokensAggregated(buffered)
	// CeilDiv(60,25) + CeilDiv(32,13) + CeilDiv(8,3) = 3+3+3 = 9
	if got != 9 {
		t.Errorf("calcUddiTokensAggregated with 20%% buffer = %d, want 9", got)
	}
}

func TestIsInfraOnlyMember(t *testing.T) {
	tests := []struct {
		name string
		m    niosServerMetricFull
		want bool
	}{
		{
			name: "GM all zeros",
			m:    niosServerMetricFull{Role: "GM", QPS: 0, LPS: 0, ObjectCount: 0, ActiveIPCount: 0},
			want: true,
		},
		{
			name: "GMC all zeros",
			m:    niosServerMetricFull{Role: "GMC", QPS: 0, LPS: 0, ObjectCount: 0, ActiveIPCount: 0},
			want: true,
		},
		{
			name: "GM with workload",
			m:    niosServerMetricFull{Role: "GM", QPS: 100, LPS: 0, ObjectCount: 0, ActiveIPCount: 0},
			want: false,
		},
		{
			name: "Member role all zeros",
			m:    niosServerMetricFull{Role: "Member", QPS: 0, LPS: 0, ObjectCount: 0, ActiveIPCount: 0},
			want: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isInfraOnlyMember(&tc.m)
			if got != tc.want {
				t.Errorf("isInfraOnlyMember(%+v) = %v, want %v", tc.m, got, tc.want)
			}
		})
	}
}

func TestServerSizingObjects(t *testing.T) {
	m := &niosServerMetricFull{ObjectCount: 1000, ActiveIPCount: 500}
	got := serverSizingObjects(m)
	if got != 1500 {
		t.Errorf("serverSizingObjects() = %d, want 1500", got)
	}
}

func TestCalcServerTokenTier(t *testing.T) {
	tests := []struct {
		name       string
		qps, lps   int
		sizingObjs int
		wantTier   string
		wantTokens int
	}{
		{"2XS tier", 5000, 75, 3000, "2XS", 130},
		{"XS tier", 10000, 150, 7500, "XS", 250},
		{"S tier", 20000, 200, 29000, "S", 470},
		{"XL cap", 200000, 1000, 1000000, "XL", 2700},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tier, tokens := calcServerTokenTier(tc.qps, tc.lps, tc.sizingObjs)
			if tier != tc.wantTier {
				t.Errorf("tier = %q, want %q", tier, tc.wantTier)
			}
			if tokens != tc.wantTokens {
				t.Errorf("tokens = %d, want %d", tokens, tc.wantTokens)
			}
		})
	}
}
