// Package orchestrator implements the fan-out scan coordinator.
// It launches one goroutine per enabled provider using sync.WaitGroup,
// collects findings with partial failure tolerance (RES-01), and publishes
// lifecycle events (provider_start, provider_complete) to the session broker.
//
// errgroup is deliberately NOT used here: errgroup cancels all goroutines on
// the first error, which would violate RES-01 (partial failure tolerance).
package orchestrator

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/broker"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// ScanProviderRequest describes a single provider to be scanned.
type ScanProviderRequest struct {
	// Provider is the provider identifier ("aws", "azure", "gcp", "ad", "nios").
	Provider string
	// Subscriptions is the list of account/subscription/project IDs to scan.
	Subscriptions []string
	// SelectionMode is "include" or "exclude" (passed through to the scanner).
	SelectionMode string
	// BackupPath is the temp file path for the NIOS backup archive.
	// Set by HandleStartScan after resolving the BackupToken from niosBackupTokens.
	BackupPath string
	// SelectedMembers is the list of NIOS Grid Member hostnames selected for scanning.
	// Empty means all members are included.
	SelectedMembers []string
}

// OrchestratorResult holds the aggregated output of a completed scan.
type OrchestratorResult struct {
	// TokenResult is the calculated token counts across all successful providers.
	TokenResult calculator.TokenResult
	// Errors contains one entry per provider that returned an error during Scan.
	Errors []session.ProviderError
}

// Orchestrator coordinates parallel provider scans.
type Orchestrator struct {
	scanners map[string]scanner.Scanner
}

// New creates an Orchestrator with the given scanners map.
// Keys must match the provider constants in the scanner package ("aws", "azure", etc.).
func New(scanners map[string]scanner.Scanner) *Orchestrator {
	return &Orchestrator{scanners: scanners}
}

// Run executes the enabled providers concurrently and returns an OrchestratorResult.
//
// Only providers listed in providers AND registered in o.scanners are invoked.
// Unknown providers are silently skipped.
//
// Run blocks until all goroutines finish (or their contexts are cancelled),
// then calls calculator.Calculate on the collected findings and closes sess.Broker.
func (o *Orchestrator) Run(ctx context.Context, sess *session.Session, providers []ScanProviderRequest) OrchestratorResult {
	var (
		mu       sync.Mutex
		findings []calculator.FindingRow
		errs     []session.ProviderError
		wg       sync.WaitGroup
	)

	for _, p := range providers {
		s, ok := o.scanners[p.Provider]
		if !ok {
			// Provider not registered — skip silently.
			continue
		}

		wg.Add(1)

		// Capture loop variables for the goroutine closure.
		providerName := p.Provider
		req := buildScanRequest(p, sess)

		go func() {
			defer wg.Done()

			// Publish provider_start before calling Scan.
			sess.Broker.Publish(broker.Event{
				Type:     "provider_start",
				Provider: providerName,
			})

			start := time.Now()

			// publish is a closure that converts scanner.Event to broker.Event.
			publish := func(e scanner.Event) {
				sess.Broker.Publish(broker.Event{
					Type:     e.Type,
					Provider: e.Provider,
					Resource: e.Resource,
					Region:   e.Region,
					Count:    e.Count,
					Status:   e.Status,
					Message:  e.Message,
					DurMS:    e.DurMS,
				})
			}

			rows, err := s.Scan(ctx, req, publish)
			durMS := time.Since(start).Milliseconds()

			if err != nil {
				// Record error but continue — other providers must not be affected.
				mu.Lock()
				errs = append(errs, session.ProviderError{
					Provider: providerName,
					Message:  err.Error(),
				})
				mu.Unlock()

				sess.Broker.Publish(broker.Event{
					Type:     "error",
					Provider: providerName,
					Message:  err.Error(),
					DurMS:    durMS,
				})
			} else {
				mu.Lock()
				findings = append(findings, rows...)
				mu.Unlock()

				// After a successful NIOS scan, type-assert to NiosResultScanner
				// to retrieve per-member metrics JSON and store it in the session.
				// NiosResultScanner is defined in internal/scanner/provider.go to
				// avoid an import cycle with internal/scanner/nios.
				if nrs, ok := s.(scanner.NiosResultScanner); ok {
					if encoded := nrs.GetNiosServerMetricsJSON(); len(encoded) > 0 {
						sess.SetNiosServerMetricsJSON(encoded)
					}
				}
			}

			// Always publish provider_complete with duration.
			sess.Broker.Publish(broker.Event{
				Type:     "provider_complete",
				Provider: providerName,
				DurMS:    durMS,
			})
		}()
	}

	wg.Wait()

	tokenResult := calculator.Calculate(findings)
	sess.Broker.Publish(broker.Event{Type: "scan_complete"})
	sess.Broker.Close()

	return OrchestratorResult{
		TokenResult: tokenResult,
		Errors:      errs,
	}
}

// buildScanRequest constructs a scanner.ScanRequest from the provider request and
// the session credentials. Credentials are copied by value so the goroutine owns
// its local copy and the session can be zeroed immediately after.
func buildScanRequest(p ScanProviderRequest, sess *session.Session) scanner.ScanRequest {
	req := scanner.ScanRequest{
		Provider:      p.Provider,
		Subscriptions: append([]string(nil), p.Subscriptions...),
		SelectionMode: p.SelectionMode,
		Credentials:   make(map[string]string),
	}

	switch p.Provider {
	case scanner.ProviderAWS:
		if sess.AWS != nil {
			req.Credentials["auth_method"] = sess.AWS.AuthMethod
			req.Credentials["access_key_id"] = sess.AWS.AccessKeyID
			req.Credentials["secret_access_key"] = sess.AWS.SecretAccessKey
			req.Credentials["session_token"] = sess.AWS.SessionToken
			req.Credentials["region"] = sess.AWS.Region
			req.Credentials["profile_name"] = sess.AWS.ProfileName
			req.Credentials["role_arn"] = sess.AWS.RoleARN
			req.Credentials["sso_access_token"] = sess.AWS.SSOAccessToken
			req.Credentials["sso_region"] = sess.AWS.SSORegion
		}
	case scanner.ProviderAzure:
		if sess.Azure != nil {
			req.Credentials["auth_method"] = sess.Azure.AuthMethod
			req.Credentials["tenant_id"] = sess.Azure.TenantID
			req.Credentials["client_id"] = sess.Azure.ClientID
			req.Credentials["client_secret"] = sess.Azure.ClientSecret
			req.Credentials["subscription_id"] = sess.Azure.SubscriptionID
			// Pass the live cached credential through the ScanRequest side-channel
			// so the Azure scanner can reuse it without a second browser popup.
			req.CachedAzureCredential = sess.Azure.CachedCredential
		}
	case scanner.ProviderGCP:
		if sess.GCP != nil {
			req.Credentials["auth_method"] = sess.GCP.AuthMethod
			req.Credentials["service_account_json"] = sess.GCP.ServiceAccountJSON
			req.Credentials["project_id"] = sess.GCP.ProjectID
			// Pass the live cached token source through the ScanRequest side-channel
			// so the GCP scanner can reuse it without a second browser popup.
			req.CachedGCPTokenSource = sess.GCP.CachedTokenSource
		}
	case scanner.ProviderAD:
		if sess.AD != nil {
			req.Credentials["auth_method"] = sess.AD.AuthMethod
			req.Credentials["servers"] = strings.Join(sess.AD.Hosts, ",")
			req.Credentials["username"] = sess.AD.Username
			req.Credentials["password"] = sess.AD.Password
			req.Credentials["domain"] = sess.AD.Domain
		}
	case scanner.ProviderNIOS:
		// BackupPath and SelectedMembers are set directly on ScanProviderRequest
		// by HandleStartScan after resolving the BackupToken from niosBackupTokens.
		req.Credentials["backup_path"] = p.BackupPath
		req.Credentials["selected_members"] = strings.Join(p.SelectedMembers, ",")
	}

	return req
}
