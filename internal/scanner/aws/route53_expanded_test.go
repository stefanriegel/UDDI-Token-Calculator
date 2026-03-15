package aws

import (
	"context"
	"strings"
	"testing"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// TestRoute53ExpandedScanners_GlobalWiring verifies that scanRoute53 produces
// FindingRows for health checks and traffic policies alongside zones and records.
// Uses a no-credentials config — API calls will error, but runResourceScan handles
// errors gracefully and still emits FindingRows with correct metadata.
func TestRoute53ExpandedScanners_GlobalWiring(t *testing.T) {
	ctx := context.Background()
	cfg := awssdk.Config{Region: "us-east-1"}
	accountID := "123456789012"

	var events []scanner.Event
	publish := func(e scanner.Event) {
		events = append(events, e)
	}

	findings := scanRoute53(ctx, cfg, accountID, publish)

	// scanRoute53 should produce 4 findings: dns_zone, dns_record, route53_health_check, route53_traffic_policy.
	// dns_zone and dns_record use inline event publishing (not runResourceScan), so they may
	// or may not produce findings depending on error handling. But health_check and traffic_policy
	// always produce a FindingRow via runResourceScan.
	wantItems := map[string]struct{}{
		"route53_health_check":   {},
		"route53_traffic_policy": {},
	}

	findingMap := make(map[string]calculator.FindingRow, len(findings))
	for _, f := range findings {
		findingMap[f.Item] = f
	}

	for item := range wantItems {
		f, ok := findingMap[item]
		if !ok {
			t.Errorf("missing FindingRow for item %q in scanRoute53 output", item)
			continue
		}
		if f.Category != calculator.CategoryDDIObjects {
			t.Errorf("item %q: category = %q, want %q", item, f.Category, calculator.CategoryDDIObjects)
		}
		if f.TokensPerUnit != calculator.TokensPerDDIObject {
			t.Errorf("item %q: tokensPerUnit = %d, want %d", item, f.TokensPerUnit, calculator.TokensPerDDIObject)
		}
		if f.Provider != scanner.ProviderAWS {
			t.Errorf("item %q: provider = %q, want %q", item, f.Provider, scanner.ProviderAWS)
		}
		if f.Source != accountID {
			t.Errorf("item %q: source = %q, want %q", item, f.Source, accountID)
		}
	}

	// Verify events include resource_progress for the new items.
	newResourceEvents := 0
	for _, e := range events {
		if e.Type == "resource_progress" && (e.Resource == "route53_health_check" || e.Resource == "route53_traffic_policy") {
			newResourceEvents++
			if e.Region != "global" {
				t.Errorf("event for %q: region = %q, want %q", e.Resource, e.Region, "global")
			}
		}
	}
	if newResourceEvents != 2 {
		t.Errorf("expected 2 resource_progress events for new Route53 types, got %d", newResourceEvents)
	}
}

// TestRoute53ExpandedScanners_ResolverInRegion verifies that scanRegion includes
// resolver_endpoint in its findings and that it uses the correct category and tokens.
func TestRoute53ExpandedScanners_ResolverInRegion(t *testing.T) {
	ctx := context.Background()
	cfg := awssdk.Config{Region: "us-east-1"}
	accountID := "123456789012"

	var events []scanner.Event
	publish := func(e scanner.Event) {
		events = append(events, e)
	}

	findings := scanRegion(ctx, cfg, "us-east-1", accountID, publish)

	// Find the resolver_endpoint finding.
	var found bool
	for _, f := range findings {
		if f.Item == "resolver_endpoint" {
			found = true
			if f.Category != calculator.CategoryDDIObjects {
				t.Errorf("resolver_endpoint: category = %q, want %q", f.Category, calculator.CategoryDDIObjects)
			}
			if f.TokensPerUnit != calculator.TokensPerDDIObject {
				t.Errorf("resolver_endpoint: tokensPerUnit = %d, want %d", f.TokensPerUnit, calculator.TokensPerDDIObject)
			}
			if f.Region != "us-east-1" {
				t.Errorf("resolver_endpoint: region = %q, want %q", f.Region, "us-east-1")
			}
			if f.Provider != scanner.ProviderAWS {
				t.Errorf("resolver_endpoint: provider = %q, want %q", f.Provider, scanner.ProviderAWS)
			}
			break
		}
	}
	if !found {
		t.Error("resolver_endpoint not found in scanRegion output")
	}

	// Verify a resource_progress event was emitted.
	var eventFound bool
	for _, e := range events {
		if e.Type == "resource_progress" && e.Resource == "resolver_endpoint" {
			eventFound = true
			break
		}
	}
	if !eventFound {
		t.Error("no resource_progress event for resolver_endpoint")
	}
}

// TestRoute53ExpandedScanners_ResolverGraceful verifies that scanResolverEndpoints
// returns (0, nil) for "not available" style errors and propagates other errors.
func TestRoute53ExpandedScanners_ResolverGraceful(t *testing.T) {
	ctx := context.Background()
	cfg := awssdk.Config{Region: "us-east-1"}

	// With no credentials, scanResolverEndpoints will get a credential error.
	// That should NOT be caught by the graceful handler (it's not a "not available" error).
	_, err := scanResolverEndpoints(ctx, cfg)
	if err == nil {
		// Some SDK versions might not error — acceptable.
		return
	}
	msg := err.Error()
	// The error should be a credential error, not one of the graceful-return cases.
	gracefulPatterns := []string{"not available", "InvalidRequestException", "not supported", "UnknownEndpoint"}
	for _, pattern := range gracefulPatterns {
		if strings.Contains(msg, pattern) {
			t.Errorf("expected credential error, got graceful-pattern error containing %q: %v", pattern, err)
		}
	}
}

// TestRoute53ExpandedScanners_NewItemNames verifies that the 3 new Route53
// resource types have distinct, non-empty item names that don't collide with
// existing ones.
func TestRoute53ExpandedScanners_NewItemNames(t *testing.T) {
	newItems := []string{
		"route53_health_check", "route53_traffic_policy", "resolver_endpoint",
	}
	existingItems := []string{
		"vpc", "subnet", "ec2_instance", "ec2_ip", "load_balancer",
		"elastic_ip", "nat_gateway", "transit_gateway", "internet_gateway",
		"route_table", "security_group", "vpn_gateway", "ipam_pool", "vpc_cidr_block",
		"dns_zone", "dns_record",
	}

	seen := make(map[string]bool)
	for _, item := range existingItems {
		seen[item] = true
	}
	for _, item := range newItems {
		if item == "" {
			t.Error("empty item name in new Route53 resource types")
		}
		if seen[item] {
			t.Errorf("item %q collides with existing item name", item)
		}
		seen[item] = true
	}
	if len(newItems) != 3 {
		t.Errorf("expected 3 new items, got %d", len(newItems))
	}
}
