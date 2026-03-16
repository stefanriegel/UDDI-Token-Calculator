// Package gcp provides the real GCP scanner implementation using the Compute and DNS REST APIs.
package gcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/checkpoint"
	"github.com/infoblox/uddi-go-token-calculator/internal/cloudutil"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// GCP OAuth2 scopes required for discovery.
// These map to the following GCP predefined roles and Infoblox permission requirements:
//
//	compute.readonly — equivalent to "Compute Viewer" predefined role.
//	  Grants: compute.networks.list/get, compute.subnetworks.aggregatedList,
//	          compute.instances.aggregatedList, compute.addresses.aggregatedList
//	  Satisfies: Infoblox Asset Discovery (VPC networks, subnets, compute instances, IPs)
//
//	dns.readonly — equivalent to "DNS Reader" predefined role.
//	  Grants: dns.managedZones.list/get, dns.resourceRecordSets.list/get, dns.projects.get
//	  Satisfies: Infoblox DNS Discovery (outbound, read-only)
//
// Reference: https://docs.infoblox.com/space/BloxOneDDI/684492268/Permissions+required+in+GCP+(Discovery)
const (
	scopeComputeReadonly = "https://www.googleapis.com/auth/compute.readonly"
	scopeDNSReadonly     = "https://www.googleapis.com/auth/dns.readonly"

	// maxConcurrentProjects is the default semaphore capacity for multi-project fan-out.
	maxConcurrentProjects = 5
)

// Scanner is the real GCP scanner implementation.
type Scanner struct{}

// New returns a new Scanner.
func New() *Scanner {
	return &Scanner{}
}

// buildTokenSource returns an OAuth2 token source for GCP API calls.
// Supports five auth methods:
//   - "adc": cached token source from ADC validation
//   - "browser-oauth": cached token source from browser consent flow
//   - "workload-identity": parse WIF configuration JSON (external_account type)
//   - "org": service account key for org-level scanning (same handling as service-account)
//   - "service-account" (default): parse service_account JSON credential
func buildTokenSource(ctx context.Context, creds map[string]string, cached oauth2.TokenSource) (oauth2.TokenSource, error) {
	switch creds["auth_method"] {
	case "adc", "browser-oauth":
		if cached != nil {
			return cached, nil
		}
		return nil, fmt.Errorf("gcp: no cached token source for %s — re-validate", creds["auth_method"])

	case "workload-identity":
		// Prefer cached token source if available (from validation).
		if cached != nil {
			return cached, nil
		}
		// Fallback: parse WIF JSON directly.
		wifJSON := creds["workload_identity_json"]
		if wifJSON == "" {
			return nil, fmt.Errorf("gcp: workload_identity_json credential is required")
		}
		googleCreds, err := google.CredentialsFromJSON(ctx, []byte(wifJSON), scopeComputeReadonly, scopeDNSReadonly)
		if err != nil {
			return nil, fmt.Errorf("gcp: failed to parse WIF configuration: %w", err)
		}
		return googleCreds.TokenSource, nil

	case "org":
		// Org mode uses the same service account key path as "service-account".
		// Prefer cached token source (set during validate) when available.
		if cached != nil {
			return cached, nil
		}
		saJSON := creds["service_account_json"]
		if saJSON == "" {
			return nil, fmt.Errorf("gcp: service_account_json credential is required for org mode")
		}
		googleCreds, err := google.CredentialsFromJSON(ctx, []byte(saJSON), scopeComputeReadonly, scopeDNSReadonly)
		if err != nil {
			return nil, fmt.Errorf("gcp: failed to parse service account credentials for org mode: %w", err)
		}
		return googleCreds.TokenSource, nil
	}

	// Service account (or empty auth_method defaults to service account).
	saJSON := creds["service_account_json"]
	if saJSON == "" {
		return nil, fmt.Errorf("gcp: service_account_json credential is required")
	}
	googleCreds, err := google.CredentialsFromJSON(ctx, []byte(saJSON), scopeComputeReadonly, scopeDNSReadonly)
	if err != nil {
		return nil, fmt.Errorf("gcp: failed to parse service account credentials: %w", err)
	}
	return googleCreds.TokenSource, nil
}

// wrapGCPError converts googleapi.Error into actionable error messages with 403/404 tagging.
// Non-googleapi errors are returned unchanged.
func wrapGCPError(err error) error {
	if err == nil {
		return nil
	}
	var gErr *googleapi.Error
	if errors.As(err, &gErr) {
		switch gErr.Code {
		case 403:
			return fmt.Errorf("GCP permission denied — %s", gErr.Message)
		case 404:
			return fmt.Errorf("GCP resource not found — %s", gErr.Message)
		default:
			return fmt.Errorf("GCP API error %d: %s", gErr.Code, gErr.Message)
		}
	}
	return err
}

// runResourceScan executes fn, publishes the result event, and returns a FindingRow.
// On error, it publishes an error event and returns a zero-count FindingRow (not a fatal error).
// Mirrors the AWS scanner runResourceScan pattern; Region is intentionally left empty for GCP
// because GCP resources are scanned at the project level, not per-region.
func runResourceScan(ctx context.Context, projectID, item, category string, tokensPerUnit int, publish func(scanner.Event), fn func() (int, error)) calculator.FindingRow {
	start := time.Now()
	count, err := fn()
	durMS := time.Since(start).Milliseconds()

	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderGCP,
			Resource: item,
			Status:   "error",
			Message:  err.Error(),
			DurMS:    durMS,
		})
		return calculator.FindingRow{
			Provider:      scanner.ProviderGCP,
			Source:        projectID,
			Category:      category,
			Item:          item,
			Count:         0,
			TokensPerUnit: tokensPerUnit,
		}
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderGCP,
		Resource: item,
		Count:    count,
		Status:   "done",
		DurMS:    durMS,
	})
	tokens := 0
	if tokensPerUnit > 0 {
		tokens = int(math.Ceil(float64(count) / float64(tokensPerUnit)))
	}
	return calculator.FindingRow{
		Provider:         scanner.ProviderGCP,
		Source:           projectID,
		Category:         category,
		Item:             item,
		Count:            count,
		TokensPerUnit:    tokensPerUnit,
		ManagementTokens: tokens,
	}
}

// scanOneProjectFunc is the function used by scanAllProjects to scan a single project.
// It defaults to scanOneProject and can be swapped in tests to inject stub results.
var scanOneProjectFunc = scanOneProject

// scanOneProject runs all resource scans for a single GCP project and returns
// the aggregated FindingRows. It scans all 13 resource types:
//   - Original 6: VPC networks, subnets, DNS zones, DNS records, compute instances, compute IPs
//   - Expanded 7: addresses, firewalls, routers, VPN gateways, VPN tunnels, GKE cluster CIDRs, secondary subnet ranges
func scanOneProject(ctx context.Context, projectID string, ts oauth2.TokenSource, opts []option.ClientOption, publish func(scanner.Event)) []calculator.FindingRow {
	var findings []calculator.FindingRow

	// ── Original 6 resource types ──

	// GCP-01: VPC Networks — CategoryDDIObjects
	findings = append(findings, runResourceScan(ctx, projectID, "vpc_network",
		calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, publish,
		func() (int, error) { return countNetworks(ctx, opts, projectID) }))

	// GCP-02: Subnets — CategoryDDIObjects
	findings = append(findings, runResourceScan(ctx, projectID, "subnet",
		calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, publish,
		func() (int, error) { return countSubnets(ctx, opts, projectID) }))

	// GCP-03 + GCP-04: DNS zones and records — handled together by countDNS.
	// runResourceScan cannot handle the paired return, so we publish manually.
	{
		start := time.Now()
		zoneCount, typeCounts, dnsErr := countDNS(ctx, ts, projectID)
		durMS := time.Since(start).Milliseconds()

		// Publish dns_zone event.
		if dnsErr != nil {
			publish(scanner.Event{
				Type:     "resource_progress",
				Provider: scanner.ProviderGCP,
				Resource: "dns_zone",
				Status:   "error",
				Message:  dnsErr.Error(),
				DurMS:    durMS,
			})
		} else {
			publish(scanner.Event{
				Type:     "resource_progress",
				Provider: scanner.ProviderGCP,
				Resource: "dns_zone",
				Count:    zoneCount,
				Status:   "done",
				DurMS:    durMS,
			})
		}

		// Always append dns_zone FindingRow (zero on error for partial-failure tolerance).
		zoneTokens := 0
		if dnsErr == nil && calculator.TokensPerDDIObject > 0 {
			zoneTokens = int(math.Ceil(float64(zoneCount) / float64(calculator.TokensPerDDIObject)))
		}
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderGCP,
			Source:           projectID,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_zone",
			Count:            zoneCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: zoneTokens,
		})

		// Publish dns_record event — aggregate total for backward compatibility.
		if dnsErr != nil {
			publish(scanner.Event{
				Type:     "resource_progress",
				Provider: scanner.ProviderGCP,
				Resource: "dns_record",
				Status:   "error",
				Message:  dnsErr.Error(),
				DurMS:    durMS,
			})
		} else {
			totalRecords := 0
			for _, c := range typeCounts {
				totalRecords += c
			}
			publish(scanner.Event{
				Type:     "resource_progress",
				Provider: scanner.ProviderGCP,
				Resource: "dns_record",
				Count:    totalRecords,
				Status:   "done",
				DurMS:    durMS,
			})
		}

		// Emit one FindingRow per non-zero record type.
		if dnsErr == nil {
			for rrtype, count := range typeCounts {
				if count == 0 {
					continue
				}
				recordTokens := 0
				if calculator.TokensPerDDIObject > 0 {
					recordTokens = int(math.Ceil(float64(count) / float64(calculator.TokensPerDDIObject)))
				}
				findings = append(findings, calculator.FindingRow{
					Provider:         scanner.ProviderGCP,
					Source:           projectID,
					Category:         calculator.CategoryDDIObjects,
					Item:             cloudutil.RecordTypeItem(rrtype),
					Count:            count,
					TokensPerUnit:    calculator.TokensPerDDIObject,
					ManagementTokens: recordTokens,
				})
			}
		}
	}

	// GCP-05 (managed assets): Compute instances — CategoryManagedAssets
	findings = append(findings, runResourceScan(ctx, projectID, "compute_instance",
		calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset, publish,
		func() (int, error) { return countInstances(ctx, opts, projectID) }))

	// GCP-05 (active IPs): Compute instance IPs — CategoryActiveIPs
	findings = append(findings, runResourceScan(ctx, projectID, "compute_ip",
		calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, publish,
		func() (int, error) { return countInstanceIPs(ctx, opts, projectID) }))

	// ── Expanded 7 resource types (T02) ──

	// GCP-06: Compute Addresses (static/reserved IPs) — CategoryActiveIPs
	findings = append(findings, runResourceScan(ctx, projectID, "compute_address",
		calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, publish,
		func() (int, error) { return countAddresses(ctx, opts, projectID) }))

	// GCP-07: Cloud Routers — CategoryManagedAssets
	findings = append(findings, runResourceScan(ctx, projectID, "cloud_router",
		calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset, publish,
		func() (int, error) { return countRouters(ctx, opts, projectID) }))

	// GCP-08: VPN Gateways — CategoryManagedAssets
	findings = append(findings, runResourceScan(ctx, projectID, "vpn_gateway",
		calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset, publish,
		func() (int, error) { return countVPNGateways(ctx, opts, projectID) }))

	// GCP-09: Forwarding Rules (load balancer frontends) — CategoryManagedAssets
	findings = append(findings, runResourceScan(ctx, projectID, "forwarding_rule",
		calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset, publish,
		func() (int, error) { return countForwardingRules(ctx, opts, projectID) }))

	// GCP-10: Internal Ranges (address blocks) — CategoryDDIObjects
	findings = append(findings, runResourceScan(ctx, projectID, "internal_range",
		calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, publish,
		func() (int, error) { return countInternalRanges(ctx, opts, projectID) }))

	// GCP-11: Firewall rules — CategoryDDIObjects
	findings = append(findings, runResourceScan(ctx, projectID, "firewall",
		calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, publish,
		func() (int, error) { return countFirewalls(ctx, opts, projectID) }))

	// GCP-12: VPN Tunnels — CategoryManagedAssets
	findings = append(findings, runResourceScan(ctx, projectID, "vpn_tunnel",
		calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset, publish,
		func() (int, error) { return countVPNTunnels(ctx, opts, projectID) }))

	// GCP-13: GKE Cluster CIDRs — CategoryDDIObjects
	findings = append(findings, runResourceScan(ctx, projectID, "gke_cluster_cidr",
		calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, publish,
		func() (int, error) { return countGKEClusterCIDRs(ctx, opts, projectID) }))

	// GCP-14: Secondary Subnet Ranges — CategoryDDIObjects
	findings = append(findings, runResourceScan(ctx, projectID, "secondary_range",
		calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, publish,
		func() (int, error) { return countSecondarySubnetRanges(ctx, opts, projectID) }))

	return findings
}

// scanAllProjects fans out scanning across all projects concurrently.
// Concurrency is limited by maxConcurrentProjects (default 5), overridden
// by maxWorkers when non-zero. Per-project failures are non-fatal: an error
// event is published and remaining projects continue.
// When checkpointPath is non-empty and there are multiple projects, completed
// projects are loaded from a prior checkpoint and skipped on resume.
func scanAllProjects(ctx context.Context, ts oauth2.TokenSource, projects []string, maxWorkers int, checkpointPath string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	workers := maxConcurrentProjects
	if maxWorkers > 0 {
		workers = maxWorkers
	}
	sem := cloudutil.NewSemaphore(workers)

	// ── Checkpoint: load prior state ──
	var cp *checkpoint.Checkpoint
	completed := make(map[string]bool)
	var findings []calculator.FindingRow

	if checkpointPath != "" && len(projects) > 1 {
		if state, loadErr := checkpoint.Load(checkpointPath); loadErr != nil {
			publish(scanner.Event{
				Type:     "checkpoint_error",
				Provider: scanner.ProviderGCP,
				Message:  fmt.Sprintf("failed to load checkpoint, starting fresh: %v", loadErr),
			})
		} else if state != nil {
			for _, u := range state.CompletedUnits {
				completed[u.ID] = true
				findings = append(findings, u.Findings...)
			}
			publish(scanner.Event{
				Type:     "checkpoint_loaded",
				Provider: scanner.ProviderGCP,
				Message:  fmt.Sprintf("resuming from checkpoint: %d projects already complete", len(state.CompletedUnits)),
			})
		}
		cp = checkpoint.New(checkpointPath, "", scanner.ProviderGCP)
	}

	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)

	for _, projID := range projects {
		projID := projID // capture
		wg.Add(1)
		go func() {
			defer wg.Done()

			if err := sem.Acquire(ctx); err != nil {
				return
			}
			defer sem.Release()

			// ── Checkpoint: skip completed projects ──
			if completed[projID] {
				publish(scanner.Event{
					Type:     "project_progress",
					Provider: scanner.ProviderGCP,
					Status:   "skipped",
					Message:  fmt.Sprintf("skipping already-completed project %s", projID),
				})
				return
			}

			publish(scanner.Event{
				Type:     "project_progress",
				Provider: scanner.ProviderGCP,
				Status:   "scanning",
				Message:  fmt.Sprintf("scanning project %s", projID),
			})

			// Each project gets its own client options from the shared token source.
			opts := []option.ClientOption{option.WithTokenSource(ts)}
			rows := scanOneProjectFunc(ctx, projID, ts, opts, publish)

			mu.Lock()
			findings = append(findings, rows...)
			mu.Unlock()

			publish(scanner.Event{
				Type:     "project_progress",
				Provider: scanner.ProviderGCP,
				Status:   "complete",
				Message:  fmt.Sprintf("completed project %s: %d findings", projID, len(rows)),
			})

			// ── Checkpoint: save after each successful project ──
			if cp != nil {
				if saveErr := cp.AddUnit(checkpoint.CompletedUnit{
					ID:          projID,
					Name:        projID,
					CompletedAt: time.Now(),
					Findings:    rows,
				}); saveErr != nil {
					publish(scanner.Event{
						Type:     "checkpoint_error",
						Provider: scanner.ProviderGCP,
						Message:  fmt.Sprintf("failed to save checkpoint: %v", saveErr),
					})
				} else {
					publish(scanner.Event{
						Type:     "checkpoint_saved",
						Provider: scanner.ProviderGCP,
						Message:  checkpointPath,
					})
				}
			}
		}()
	}

	wg.Wait()

	// ── Checkpoint: clean up on full success ──
	if cp != nil && checkpointPath != "" {
		_ = checkpoint.Delete(checkpointPath)
	}

	return findings, nil
}

// Scan implements scanner.Scanner for GCP.
// It discovers VPC networks, subnets, Cloud DNS zones + records, compute instances,
// instance IPs, and 7 expanded resource types (addresses, firewalls, routers,
// VPN gateways, VPN tunnels, GKE cluster CIDRs, secondary subnet ranges).
// When multiple subscriptions (projects) are provided, it fans out concurrently.
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	// Step 1: Build token source.
	ts, err := buildTokenSource(ctx, req.Credentials, req.CachedGCPTokenSource)
	if err != nil {
		return nil, err
	}

	// Step 2: Multi-project fan-out when more than one subscription is provided.
	if len(req.Subscriptions) > 1 {
		return scanAllProjects(ctx, ts, req.Subscriptions, req.MaxWorkers, req.CheckpointPath, publish)
	}

	// Step 3: Single-project scan — extract project ID.
	projectID := ""
	if len(req.Subscriptions) > 0 {
		projectID = req.Subscriptions[0]
	}
	if projectID == "" {
		projectID = req.Credentials["project_id"]
	}
	if projectID == "" {
		return nil, fmt.Errorf("gcp: project ID is required — set Subscriptions[0] or credentials[\"project_id\"]")
	}

	// Step 4: Build shared client options and scan.
	opts := []option.ClientOption{option.WithTokenSource(ts)}
	return scanOneProject(ctx, projectID, ts, opts, publish), nil
}
