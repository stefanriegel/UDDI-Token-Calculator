// Package aws provides scanner implementations for Amazon Web Services.
// Stub implements scanner.Scanner using hardcoded zero counts.
// Replace with real AWS SDK implementation in Phase 3.
package aws

import (
	"context"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Stub implements scanner.Scanner for AWS using hardcoded zero counts.
// It exercises the full data pipeline (events, FindingRows, token math)
// without requiring any AWS credentials or API calls.
type Stub struct{}

// Scan publishes resource_progress events and returns zero-count FindingRows
// for all AWS resource types that the real Phase 3 implementation will discover.
func (s *Stub) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	source := "stub-aws-account"
	if len(req.Subscriptions) > 0 {
		source = req.Subscriptions[0]
	}

	resources := []struct {
		item          string
		category      string
		tokensPerUnit int
	}{
		{"vpc", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_record", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"ec2_instance", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"load_balancer", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
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
			Provider: scanner.ProviderAWS,
			Resource: r.item,
			Count:    0,
			Status:   "done",
		})

		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAWS,
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
