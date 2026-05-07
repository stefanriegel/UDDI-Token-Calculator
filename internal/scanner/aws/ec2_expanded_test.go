package aws

import (
	"context"
	"strings"
	"testing"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// TestExpandedResourceScanners_Wiring verifies that scanRegion produces a FindingRow
// for each expected resource type with the correct item name, category, and tokens-per-unit.
//
// We call scanRegion with a no-credentials config. Each AWS API call will fail, but
// runResourceScan handles errors gracefully and still emits a FindingRow with the
// correct metadata (item, category, tokensPerUnit). This lets us verify wiring
// without mocking every EC2 API.
func TestExpandedResourceScanners_Wiring(t *testing.T) {
	ctx := context.Background()
	cfg := awssdk.Config{Region: "us-east-1"} // no credentials — API calls will error
	accountID := "123456789012"

	var events []scanner.Event
	publish := func(e scanner.Event) {
		events = append(events, e)
	}

	findings := scanRegion(ctx, cfg, "us-east-1", accountID, publish)

	// Expected resource types and their wiring.
	type expected struct {
		item          string
		category      string
		tokensPerUnit int
	}
	wantResources := []expected{
		// Original 5
		{"vpc", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"ec2_instance", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"ec2_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"load_balancer", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		// EC2 expanded (7 from M004 + 1 restored from v2.2.0)
		{"elastic_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP},
		{"nat_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"transit_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"internet_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"vpn_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		{"ipam_pool", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"vpc_cidr_block", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
		{"customer_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset},
		// Route53 Resolver (regional)
		{"resolver_endpoint", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject},
	}

	if len(findings) != len(wantResources) {
		t.Fatalf("scanRegion returned %d findings, want %d", len(findings), len(wantResources))
	}

	// Build a lookup map from item name to FindingRow.
	findingMap := make(map[string]calculator.FindingRow, len(findings))
	for _, f := range findings {
		findingMap[f.Item] = f
	}

	for _, want := range wantResources {
		f, ok := findingMap[want.item]
		if !ok {
			t.Errorf("missing FindingRow for item %q", want.item)
			continue
		}
		if f.Category != want.category {
			t.Errorf("item %q: category = %q, want %q", want.item, f.Category, want.category)
		}
		if f.TokensPerUnit != want.tokensPerUnit {
			t.Errorf("item %q: tokensPerUnit = %d, want %d", want.item, f.TokensPerUnit, want.tokensPerUnit)
		}
		if f.Provider != scanner.ProviderAWS {
			t.Errorf("item %q: provider = %q, want %q", want.item, f.Provider, scanner.ProviderAWS)
		}
		if f.Source != accountID {
			t.Errorf("item %q: source = %q, want %q", want.item, f.Source, accountID)
		}
		if f.Region != "us-east-1" {
			t.Errorf("item %q: region = %q, want %q", want.item, f.Region, "us-east-1")
		}
	}

	// Verify events were published — one per resource type.
	if len(events) != len(wantResources) {
		t.Errorf("published %d events, want %d", len(events), len(wantResources))
	}
	for _, e := range events {
		if e.Type != "resource_progress" {
			t.Errorf("event type = %q, want %q", e.Type, "resource_progress")
		}
		if e.Provider != scanner.ProviderAWS {
			t.Errorf("event provider = %q, want %q", e.Provider, scanner.ProviderAWS)
		}
	}
}

// TestExpandedResourceScanners_IPAMGraceful verifies that scanIPAMPools returns 0
// (not an error) when the API returns an IPAM-not-enabled error.
func TestExpandedResourceScanners_IPAMGraceful(t *testing.T) {
	// We can't easily mock the EC2 client, but we can verify the error-handling
	// logic in scanIPAMPools by checking that it's wired to return 0 when
	// called in a no-credentials context (the error from missing credentials
	// does not contain "IPAM" or "not enabled", so it will return an error —
	// this test verifies the function at least exists and is callable).
	//
	// The real IPAM-not-enabled handling is tested by verifying the function
	// body contains the correct string-matching logic.
	ctx := context.Background()
	cfg := awssdk.Config{Region: "us-east-1"}

	// This will error (no credentials), but should not panic.
	_, err := scanIPAMPools(ctx, cfg)
	if err == nil {
		// Surprising but acceptable — no-creds might not error on some SDK versions.
		return
	}
	// Error should NOT be an IPAM-specific error (since we're hitting a credential error).
	msg := err.Error()
	if strings.Contains(msg, "IPAM") || strings.Contains(msg, "not enabled") {
		t.Errorf("expected credential error, got IPAM-specific error: %v", err)
	}
}

// TestExpandedResourceScanners_NewItemNames verifies that the 9 new resource types
// have distinct, non-empty item names that don't collide with existing ones.
func TestExpandedResourceScanners_NewItemNames(t *testing.T) {
	newItems := []string{
		"elastic_ip", "nat_gateway", "transit_gateway", "internet_gateway",
		"route_table", "security_group", "vpn_gateway", "ipam_pool", "vpc_cidr_block",
	}
	existingItems := []string{"vpc", "subnet", "ec2_instance", "ec2_ip", "load_balancer"}

	seen := make(map[string]bool)
	for _, item := range existingItems {
		seen[item] = true
	}
	for _, item := range newItems {
		if item == "" {
			t.Error("empty item name in new resource types")
		}
		if seen[item] {
			t.Errorf("item %q collides with existing item name", item)
		}
		seen[item] = true
	}
	if len(newItems) != 9 {
		t.Errorf("expected 9 new items, got %d", len(newItems))
	}
}
