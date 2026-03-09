package aws

import (
	"context"
	"sync"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
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

// scanAllRegions fans out one goroutine per region, gated by a buffered channel semaphore
// of capacity maxConcurrentRegions. Each goroutine calls scanRegion then appends results
// under a mutex. WaitGroup ensures all goroutines finish before returning.
func scanAllRegions(ctx context.Context, baseCfg awssdk.Config, regions []string, accountID string, publish func(scanner.Event)) []calculator.FindingRow {
	sem := make(chan struct{}, maxConcurrentRegions)
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
			// Acquire semaphore — use select to respect context cancellation.
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

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
		Category:         category,
		Item:             item,
		Count:            count,
		TokensPerUnit:    tokensPerUnit,
		ManagementTokens: tokens,
	}
}
