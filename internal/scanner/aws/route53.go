package aws

import (
	"context"
	"strings"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/route53"
	"github.com/aws/aws-sdk-go-v2/service/route53resolver"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/cloudutil"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// scanRoute53 performs a single global Route53 scan (zones, record sets, health checks, traffic policies).
// Emits one event per resource type. Uses Region: "global" since Route53 is not region-specific.
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

	// Record sets — per-type counts across all zones
	recStart := time.Now()
	typeCounts, err := countAllRecordSetsByType(ctx, cfg, zoneIDs)
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
		// Sum for backward-compatible aggregate progress event.
		totalRecords := 0
		for _, c := range typeCounts {
			totalRecords += c
		}
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAWS,
			Resource: "dns_record",
			Region:   "global",
			Count:    totalRecords,
			Status:   "done",
			DurMS:    recDur,
		})
		// Emit one FindingRow per non-zero record type.
		for rrtype, count := range typeCounts {
			if count == 0 {
				continue
			}
			tokens := (count + calculator.TokensPerDDIObject - 1) / calculator.TokensPerDDIObject
			findings = append(findings, calculator.FindingRow{
				Provider:         scanner.ProviderAWS,
				Source:           accountID,
				Category:         calculator.CategoryDDIObjects,
				Item:             cloudutil.RecordTypeItem(rrtype),
				Count:            count,
				TokensPerUnit:    calculator.TokensPerDDIObject,
				ManagementTokens: tokens,
			})
		}
	}

	// Route53 Health Checks (global)
	findings = append(findings, runResourceScan(ctx, cfg, "global", accountID,
		"route53_health_check", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanRoute53HealthChecks(ctx, cfg) }))

	// Route53 Traffic Policies (global)
	findings = append(findings, runResourceScan(ctx, cfg, "global", accountID,
		"route53_traffic_policy", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanRoute53TrafficPolicies(ctx, cfg) }))

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

// countAllRecordSetsByType counts all resource record sets across all zones,
// grouped by RR type (e.g. "A", "AAAA", "CNAME").  Returns a non-nil map even
// when no records are found.
func countAllRecordSetsByType(ctx context.Context, cfg awssdk.Config, zoneIDs []string) (map[string]int, error) {
	client := route53.NewFromConfig(cfg)
	counts := map[string]int{}
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
			for _, rrs := range page.ResourceRecordSets {
				counts[string(rrs.Type)]++
			}
		}
	}
	return counts, nil
}

// stripZoneID removes the "/hostedzone/" prefix from a Route53 zone ID.
// AWS returns IDs like "/hostedzone/Z1ABCDEF"; the ListResourceRecordSets API
// requires the bare ID "Z1ABCDEF".
func stripZoneID(id string) string {
	return strings.TrimPrefix(id, "/hostedzone/")
}

// scanRoute53HealthChecks returns the total number of Route53 health checks
// using the built-in ListHealthChecks paginator.
func scanRoute53HealthChecks(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := route53.NewFromConfig(cfg)
	paginator := route53.NewListHealthChecksPaginator(client, &route53.ListHealthChecksInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.HealthChecks)
	}
	return count, nil
}

// scanRoute53TrafficPolicies returns the total number of Route53 traffic policies.
// Uses manual pagination with IsTruncated/TrafficPolicyIdMarker since the SDK
// does not provide a built-in paginator for ListTrafficPolicies.
func scanRoute53TrafficPolicies(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := route53.NewFromConfig(cfg)
	count := 0
	var marker *string
	for {
		out, err := client.ListTrafficPolicies(ctx, &route53.ListTrafficPoliciesInput{
			TrafficPolicyIdMarker: marker,
		})
		if err != nil {
			return count, err
		}
		count += len(out.TrafficPolicySummaries)
		if !out.IsTruncated {
			break
		}
		marker = out.TrafficPolicyIdMarker
	}
	return count, nil
}

// scanResolverEndpoints returns the total number of Route53 Resolver endpoints
// in a region. Route53 Resolver is a regional service (unlike Route53 itself).
// Gracefully returns 0 if the service is not available in the region.
func scanResolverEndpoints(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := route53resolver.NewFromConfig(cfg)
	paginator := route53resolver.NewListResolverEndpointsPaginator(client, &route53resolver.ListResolverEndpointsInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			msg := err.Error()
			// Graceful: some regions don't support Route53 Resolver.
			if strings.Contains(msg, "not available") ||
				strings.Contains(msg, "InvalidRequestException") ||
				strings.Contains(msg, "not supported") ||
				strings.Contains(msg, "UnknownEndpoint") {
				return 0, nil
			}
			return count, err
		}
		count += len(page.ResolverEndpoints)
	}
	return count, nil
}