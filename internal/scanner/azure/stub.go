// Package azure provides scanner implementations for Microsoft Azure.
// Stub implements scanner.Scanner using hardcoded zero counts.
// Replace with real Azure SDK implementation in Phase 4.
package azure

import (
	"context"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Stub implements scanner.Scanner for Azure using hardcoded zero counts.
// It exercises the full data pipeline (events, FindingRows, token math)
// without requiring any Azure credentials or API calls.
type Stub struct{}

// Scan publishes resource_progress events and returns zero-count FindingRows
// for all Azure resource types that the real Phase 4 implementation will discover.
func (s *Stub) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	source := "stub-azure-subscription"
	if len(req.Subscriptions) > 0 {
		source = req.Subscriptions[0]
	}

	resources := []struct {
		item          string
		category      string
		tokensPerUnit int
	}{
		{"vnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_record", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"virtual_machine", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"load_balancer", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"application_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
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
			Provider: scanner.ProviderAzure,
			Resource: r.item,
			Count:    0,
			Status:   "done",
		})

		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
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
