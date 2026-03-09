// Package gcp provides the real GCP scanner implementation using the Compute and DNS REST APIs.
package gcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

const (
	scopeComputeReadonly = "https://www.googleapis.com/auth/compute.readonly"
	scopeDNSReadonly     = "https://www.googleapis.com/auth/dns.readonly"
)

// Scanner is the real GCP scanner implementation.
type Scanner struct{}

// New returns a new Scanner.
func New() *Scanner {
	return &Scanner{}
}

// buildTokenSource returns an OAuth2 token source for GCP API calls.
// For browser-oauth auth method, it returns the cached token source from validation.
// For service-account auth method, it parses the service_account_json credential.
func buildTokenSource(ctx context.Context, creds map[string]string, cached oauth2.TokenSource) (oauth2.TokenSource, error) {
	if creds["auth_method"] == "browser-oauth" {
		if cached != nil {
			return cached, nil
		}
		return nil, fmt.Errorf("gcp: no cached token source for browser-oauth — re-validate")
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

// Scan implements scanner.Scanner for GCP.
// It discovers VPC networks, subnets, Cloud DNS zones + records, compute instances, and instance IPs.
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	// Step 1: Build token source.
	ts, err := buildTokenSource(ctx, req.Credentials, req.CachedGCPTokenSource)
	if err != nil {
		return nil, err
	}

	// Step 2: Extract project ID — Subscriptions[0] takes precedence over credentials map.
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

	// Step 3: Build shared client options.
	opts := []option.ClientOption{option.WithTokenSource(ts)}

	var findings []calculator.FindingRow

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
		zoneCount, recordCount, dnsErr := countDNS(ctx, ts, projectID)
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

		// Publish dns_record event.
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
			publish(scanner.Event{
				Type:     "resource_progress",
				Provider: scanner.ProviderGCP,
				Resource: "dns_record",
				Count:    recordCount,
				Status:   "done",
				DurMS:    durMS,
			})
		}

		// Always append dns_record FindingRow.
		recordTokens := 0
		if dnsErr == nil && calculator.TokensPerDDIObject > 0 {
			recordTokens = int(math.Ceil(float64(recordCount) / float64(calculator.TokensPerDDIObject)))
		}
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderGCP,
			Source:           projectID,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_record",
			Count:            recordCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: recordTokens,
		})
	}

	// GCP-05 (managed assets): Compute instances — CategoryManagedAssets
	findings = append(findings, runResourceScan(ctx, projectID, "compute_instance",
		calculator.CategoryManagedAssets, calculator.TokensPerManagedAsset, publish,
		func() (int, error) { return countInstances(ctx, opts, projectID) }))

	// GCP-05 (active IPs): Compute instance IPs — CategoryActiveIPs
	findings = append(findings, runResourceScan(ctx, projectID, "compute_ip",
		calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, publish,
		func() (int, error) { return countInstanceIPs(ctx, opts, projectID) }))

	return findings, nil
}
