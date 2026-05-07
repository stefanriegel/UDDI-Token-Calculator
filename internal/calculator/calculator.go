// Package calculator implements the Infoblox Universal DDI token math.
//
// Token sizing constants (from official Infoblox documentation):
//   - DDI Objects: 1 token per 25 objects (ceiling division)
//   - Active IPs:  1 token per 13 IPs (ceiling division)
//   - Managed Assets: 1 token per 3 assets (ceiling division)
//   - Grand total = max(DDITokens, IPTokens, AssetTokens)
//
// NIOS Grid uses different (more generous) ratios because NIOS licensing
// covers multiple management domains per token:
//   - DDI Objects: 1 token per 50 objects
//   - Active IPs:  1 token per 25 IPs
//   - Managed Assets: 1 token per 13 assets
// NIOS rates apply to the current-state NIOS token count. When members
// migrate to NIOS-X (UDDI native), the native rates above apply instead.
package calculator

const (
	CategoryDDIObjects    = "DDI Objects"
	CategoryActiveIPs     = "Active IPs"
	CategoryManagedAssets = "Managed Assets"

	// Native UDDI rates (AWS, Azure, GCP, NIOS-X, BlueCat, EfficientIP).
	TokensPerDDIObject    = 25
	TokensPerActiveIP     = 13
	TokensPerManagedAsset = 3

	// NIOS Grid rates — for counting objects managed by an existing NIOS Grid.
	// These apply to FindingRows emitted by the NIOS scanner for current-state
	// token estimation. Migration Planner uses native rates for migrated members.
	NIOSTokensPerDDIObject    = 50
	NIOSTokensPerActiveIP     = 25
	NIOSTokensPerManagedAsset = 13
)

// FindingRow is the universal currency between all scanner phases and the results display.
// It represents a single resource type discovered by a provider.
type FindingRow struct {
	// Provider is the cloud/directory provider name (e.g. "aws", "azure", "gcp", "ad").
	Provider string
	// Source is the account identifier (AWS account ID, Azure subscription ID, GCP project ID, AD domain).
	Source string
	// Region is the cloud region this row was scanned from (e.g. "us-east-1"). Empty for global resources.
	Region string
	// Category is one of CategoryDDIObjects, CategoryActiveIPs, or CategoryManagedAssets.
	Category string
	// Item is the resource type name (e.g. "vpc", "subnet", "vm").
	Item string
	// Count is the number of discovered resources of this type.
	Count int
	// TokensPerUnit is the divisor used for ceiling division (25, 13, or 3).
	TokensPerUnit int
	// ManagementTokens is ceiling(Count / TokensPerUnit) for this individual row.
	ManagementTokens int
}

// TokenResult holds the aggregated token calculation across all findings.
type TokenResult struct {
	// DDITokens is ceiling(sum of all DDI Object counts / 25).
	DDITokens int
	// IPTokens is ceiling(sum of all Active IP counts / 13).
	IPTokens int
	// AssetTokens is ceiling(sum of all Managed Asset counts / 3).
	AssetTokens int
	// GrandTotal is max(DDITokens, IPTokens, AssetTokens).
	GrandTotal int
	// Findings is the original input slice, returned for traceability.
	Findings []FindingRow
}

// CeilDiv computes ceiling(n / d). Returns 0 if n is 0 to avoid division concerns.
// Panics if d is 0 (caller must supply non-zero divisor).
// Exported so that all scanners share the same integer ceiling-division logic.
func CeilDiv(n, d int) int {
	if n == 0 {
		return 0
	}
	return (n + d - 1) / d
}

func max3(a, b, c int) int {
	m := a
	if b > m {
		m = b
	}
	if c > m {
		m = c
	}
	return m
}

// Calculate aggregates all findings by category, applies ceiling division, and returns a TokenResult.
//
// Aggregation happens before division: all rows in the same category are summed first,
// then a single ceiling division is applied to the total. This matches the Infoblox
// token sizing model (objects per token is a fleet-wide ratio, not a per-source ratio).
func Calculate(findings []FindingRow) TokenResult {
	if findings == nil {
		findings = []FindingRow{}
	}

	var totalDDI, totalIP, totalAsset int
	for _, row := range findings {
		switch row.Category {
		case CategoryDDIObjects:
			totalDDI += row.Count
		case CategoryActiveIPs:
			totalIP += row.Count
		case CategoryManagedAssets:
			totalAsset += row.Count
		}
	}

	ddiTokens := CeilDiv(totalDDI, TokensPerDDIObject)
	ipTokens := CeilDiv(totalIP, TokensPerActiveIP)
	assetTokens := CeilDiv(totalAsset, TokensPerManagedAsset)

	return TokenResult{
		DDITokens:   ddiTokens,
		IPTokens:    ipTokens,
		AssetTokens: assetTokens,
		GrandTotal:  max3(ddiTokens, ipTokens, assetTokens),
		Findings:    findings,
	}
}
