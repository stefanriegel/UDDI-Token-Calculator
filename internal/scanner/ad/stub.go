// Package ad provides scanner implementations for Active Directory via WinRM.
// Stub implements scanner.Scanner using hardcoded zero counts.
// Replace with real WinRM/AD implementation in Phase 6.
package ad

import (
	"context"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Stub implements scanner.Scanner for Active Directory using hardcoded zero counts.
// It exercises the full data pipeline (events, FindingRows, token math)
// without requiring any WinRM connection or AD credentials.
type Stub struct{}

// Scan publishes resource_progress events and returns zero-count FindingRows
// for all AD resource types that the real Phase 6 implementation will discover.
func (s *Stub) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	source := "stub-dc.example.com"
	if h, ok := req.Credentials["host"]; ok && h != "" {
		source = h
	}

	resources := []struct {
		item          string
		category      string
		tokensPerUnit int
	}{
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_record", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dhcp_scope", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dhcp_lease", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"user_account", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
	}

	findings := make([]calculator.FindingRow, 0, len(resources))
	for _, r := range resources {
		select {
		case <-ctx.Done():
			return findings, ctx.Err()
		default:
		}

		time.Sleep(50 * time.Millisecond)

		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: r.item,
			Count:    0,
			Status:   "done",
		})

		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAD,
			Source:           source,
			Category:         r.category,
			Item:             r.item,
			Count:            0,
			TokensPerUnit:    r.tokensPerUnit,
			ManagementTokens: 0,
		})
	}

	return findings, nil
}
