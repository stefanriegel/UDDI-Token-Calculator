package aws

import (
	"context"
	"strings"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/route53"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// scanRoute53 performs a single global Route53 scan (zones + all record sets).
// Emits two events: one for hosted zones, one for record sets.
// Uses Region: "global" since Route53 is not region-specific.
func scanRoute53(ctx context.Context, cfg awssdk.Config, accountID string, publish func(scanner.Event)) []calculator.FindingRow {
	var findings []calculator.FindingRow

	// Hosted zones
	zoneStart := time.Now()
	zones, zoneIDs, err := listHostedZones(ctx, cfg)
	zoneDur := time.Since(zoneStart).Milliseconds()
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAWS,
			Resource: "dns_zone",
			Region:   "global",
			Status:   "error",
			Message:  err.Error(),
			DurMS:    zoneDur,
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAWS,
			Resource: "dns_zone",
			Region:   "global",
			Count:    zones,
			Status:   "done",
			DurMS:    zoneDur,
		})
		tokens := 0
		if zones > 0 {
			tokens = (zones + calculator.TokensPerDDIObject - 1) / calculator.TokensPerDDIObject
		}
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAWS,
			Source:           accountID,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_zone",
			Count:            zones,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: tokens,
		})
	}

	// Record sets — sum across all zones
	recStart := time.Now()
	records, err := countAllRecordSets(ctx, cfg, zoneIDs)
	recDur := time.Since(recStart).Milliseconds()
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAWS,
			Resource: "dns_record",
			Region:   "global",
			Status:   "error",
			Message:  err.Error(),
			DurMS:    recDur,
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAWS,
			Resource: "dns_record",
			Region:   "global",
			Count:    records,
			Status:   "done",
			DurMS:    recDur,
		})
		tokens := 0
		if records > 0 {
			tokens = (records + calculator.TokensPerDDIObject - 1) / calculator.TokensPerDDIObject
		}
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAWS,
			Source:           accountID,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_record",
			Count:            records,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: tokens,
		})
	}

	return findings
}

// listHostedZones returns the zone count and a slice of bare zone IDs (prefix stripped).
func listHostedZones(ctx context.Context, cfg awssdk.Config) (int, []string, error) {
	client := route53.NewFromConfig(cfg)
	paginator := route53.NewListHostedZonesPaginator(client, &route53.ListHostedZonesInput{})
	count := 0
	var ids []string
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, ids, err
		}
		for _, z := range page.HostedZones {
			count++
			if z.Id != nil {
				ids = append(ids, stripZoneID(*z.Id))
			}
		}
	}
	return count, ids, nil
}

// countAllRecordSets sums all resource record sets across all zones.
func countAllRecordSets(ctx context.Context, cfg awssdk.Config, zoneIDs []string) (int, error) {
	client := route53.NewFromConfig(cfg)
	total := 0
	for _, zid := range zoneIDs {
		paginator := route53.NewListResourceRecordSetsPaginator(client, &route53.ListResourceRecordSetsInput{
			HostedZoneId: awssdk.String(zid),
		})
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(ctx)
			if err != nil {
				// Skip this zone on error — continue counting others.
				break
			}
			total += len(page.ResourceRecordSets)
		}
	}
	return total, nil
}

// stripZoneID removes the "/hostedzone/" prefix from a Route53 zone ID.
// AWS returns IDs like "/hostedzone/Z1ABCDEF"; the ListResourceRecordSets API
// requires the bare ID "Z1ABCDEF".
func stripZoneID(id string) string {
	return strings.TrimPrefix(id, "/hostedzone/")
}
