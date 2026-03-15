package aws

import (
	"context"
	"sync"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/cloudutil"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

const maxConcurrentRegions = 5

// configForRegion returns a copy of base with Region set to region.
// NEVER mutate base.Region directly — aws.Config contains shared pointers internally.
func configForRegion(base awssdk.Config, region string) awssdk.Config {
	c := base.Copy()
	c.Region = region
	return c
}

// listEnabledRegions calls ec2:DescribeRegions with AllRegions=nil (default=enabled only).
// Returns the list of region name strings.
func listEnabledRegions(ctx context.Context, cfg awssdk.Config) ([]string, error) {
	client := ec2.NewFromConfig(cfg)
	out, err := client.DescribeRegions(ctx, &ec2.DescribeRegionsInput{
		// AllRegions nil = only opt-in-not-required and opted-in regions
	})
	if err != nil {
		return nil, err
	}
	regions := make([]string, 0, len(out.Regions))
	for _, r := range out.Regions {
		if r.RegionName != nil {
			regions = append(regions, *r.RegionName)
		}
	}
	return regions, nil
}

// scanAllRegions fans out one goroutine per region, gated by a cloudutil.Semaphore
// of the given maxWorkers capacity (0 defaults to maxConcurrentRegions).
// Each goroutine calls scanRegion then appends results under a mutex.
// WaitGroup ensures all goroutines finish before returning.
func scanAllRegions(ctx context.Context, baseCfg awssdk.Config, regions []string, accountID string, maxWorkers int, publish func(scanner.Event)) []calculator.FindingRow {
	if maxWorkers <= 0 {
		maxWorkers = maxConcurrentRegions
	}
	sem := cloudutil.NewSemaphore(maxWorkers)
	var (
		mu       sync.Mutex
		wg       sync.WaitGroup
		findings []calculator.FindingRow
	)

	for _, region := range regions {
		region := region // capture loop variable
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Acquire semaphore — returns ctx.Err() on cancellation.
			if err := sem.Acquire(ctx); err != nil {
				return
			}
			defer sem.Release()

			// Check cancellation after acquiring slot, before doing any work.
			if ctx.Err() != nil {
				return
			}

			rows := scanRegion(ctx, configForRegion(baseCfg, region), region, accountID, publish)
			mu.Lock()
			findings = append(findings, rows...)
			mu.Unlock()
		}()
	}

	wg.Wait()
	return findings
}

// scanRegion runs all regional API calls sequentially for one region.
// Each resource type publishes one event immediately after its API call completes.
// If a resource call fails, an error event is published and scanning continues
// for the remaining resource types in this region.
func scanRegion(ctx context.Context, cfg awssdk.Config, region string, accountID string, publish func(scanner.Event)) []calculator.FindingRow {
	var findings []calculator.FindingRow

	// VPCs
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"vpc", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanVPCs(ctx, cfg) }))

	// Subnets
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"subnet", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanSubnets(ctx, cfg) }))

	// EC2 instances (count = number of non-terminated instances)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"ec2_instance", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset,
		publish, func() (int, error) { return scanInstanceCount(ctx, cfg) }))

	// EC2 IPs (count = total IPs across all instances)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"ec2_ip", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP,
		publish, func() (int, error) { return scanInstanceIPs(ctx, cfg) }))

	// Load balancers (elbv2 only: ALB, NLB, GWLB)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"load_balancer", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset,
		publish, func() (int, error) { return scanLoadBalancers(ctx, cfg) }))

	// Elastic IPs
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"elastic_ip", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanElasticIPs(ctx, cfg) }))

	// NAT gateways (excludes deleted)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"nat_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset,
		publish, func() (int, error) { return scanNATGateways(ctx, cfg) }))

	// Transit gateways
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"transit_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset,
		publish, func() (int, error) { return scanTransitGateways(ctx, cfg) }))

	// Internet gateways
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"internet_gateway", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanInternetGateways(ctx, cfg) }))

	// Route tables
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"route_table", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanRouteTables(ctx, cfg) }))

	// Security groups
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"security_group", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanSecurityGroups(ctx, cfg) }))

	// VPN gateways (excludes deleted)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"vpn_gateway", calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset,
		publish, func() (int, error) { return scanVPNGateways(ctx, cfg) }))

	// IPAM pools (graceful 0 when IPAM not enabled)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"ipam_pool", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanIPAMPools(ctx, cfg) }))

	// VPC CIDR blocks (counts associations, not VPC count)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"vpc_cidr_block", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanVPCCIDRBlocks(ctx, cfg) }))

	// Route53 Resolver endpoints (regional service, separate from Route53)
	findings = append(findings, runResourceScan(ctx, cfg, region, accountID,
		"resolver_endpoint", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject,
		publish, func() (int, error) { return scanResolverEndpoints(ctx, cfg) }))

	return findings
}

// runResourceScan executes fn, publishes the result event, and returns a FindingRow.
// On error, it publishes an error event and returns a zero-count FindingRow (not a fatal error).
func runResourceScan(ctx context.Context, cfg awssdk.Config, region, accountID, item, category string, tokensPerUnit int, publish func(scanner.Event), fn func() (int, error)) calculator.FindingRow {
	start := time.Now()
	count, err := fn()
	durMS := time.Since(start).Milliseconds()

	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAWS,
			Resource: item,
			Region:   region,
			Status:   "error",
			Message:  err.Error(),
			DurMS:    durMS,
		})
		return calculator.FindingRow{
			Provider:      scanner.ProviderAWS,
			Source:        accountID,
			Region:        region,
			Category:      category,
			Item:          item,
			Count:         0,
			TokensPerUnit: tokensPerUnit,
		}
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAWS,
		Resource: item,
		Region:   region,
		Count:    count,
		Status:   "done",
		DurMS:    durMS,
	})
	tokens := 0
	if tokensPerUnit > 0 {
		tokens = (count + tokensPerUnit - 1) / tokensPerUnit
	}
	return calculator.FindingRow{
		Provider:         scanner.ProviderAWS,
		Source:           accountID,
		Region:           region,
		Category:         category,
		Item:             item,
		Count:            count,
		TokensPerUnit:    tokensPerUnit,
		ManagementTokens: tokens,
	}
}
