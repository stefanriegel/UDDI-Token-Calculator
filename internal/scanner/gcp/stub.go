// Package gcp provides scanner implementations for Google Cloud Platform.
// Stub implements scanner.Scanner using hardcoded zero counts.
// Replace with real GCP SDK implementation in Phase 5.
package gcp

import (
	"context"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Stub implements scanner.Scanner for GCP using hardcoded zero counts.
// It exercises the full data pipeline (events, FindingRows, token math)
// without requiring any GCP credentials or API calls.
type Stub struct{}

// Scan publishes resource_progress events and returns zero-count FindingRows
// for all GCP resource types that the real Phase 5 implementation will discover.
func (s *Stub) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	source := "stub-gcp-project"
	if len(req.Subscriptions) > 0 {
		source = req.Subscriptions[0]
	}

	resources := []struct {
		item          string
		category      string
		tokensPerUnit int
	}{
		{"vpc_network", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_zone", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"dns_record", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"compute_instance", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
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
			Provider: scanner.ProviderGCP,
			Resource: r.item,
			Count:    0,
			Status:   "done",
		})

		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderGCP,
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
