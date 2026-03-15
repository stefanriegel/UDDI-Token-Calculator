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
	// Provider is the provider identifier ("aws", "azure", "gcp", "ad", "nios", "bluecat", "efficientip").
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
	// Mode selects the NIOS scan mode: "backup" (default) or "wapi" (live WAPI).
	Mode string
	// MaxWorkers is the maximum number of concurrent workers for this provider.
	// 0 means use the provider's default concurrency.
	MaxWorkers int
	// RequestTimeout is the per-request timeout in seconds for this provider.
	// 0 means use the provider's default timeout.
	RequestTimeout int
	// CheckpointPath is the file path for checkpoint persistence. Empty means no checkpointing.
	CheckpointPath string
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
		// Determine which scanner key to use. NIOS with mode="wapi" uses
		// the "nios-wapi" key to dispatch to WAPIScanner instead of the
		// backup-based scanner registered under "nios".
		scannerKey := p.Provider
		if p.Provider == scanner.ProviderNIOS && p.Mode == "wapi" {
			scannerKey = "nios-wapi"
		}

		s, ok := o.scanners[scannerKey]
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

			// Initialize provider progress as running at 5%.
			sess.UpdateProviderProgress(providerName, "running", 5, 0)

			// Publish provider_start before calling Scan.
			sess.Broker.Publish(broker.Event{
				Type:     "provider_start",
				Provider: providerName,
			})

			start := time.Now()

			// Track the number of resource_progress events to estimate progress.
			eventCount := 0
			totalItems := 0

			// publish is a closure that converts scanner.Event to broker.Event
			// and updates per-provider progress tracking in the session.
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

				// Update progress on each resource_progress event.
				if e.Type == "resource_progress" {
					eventCount++
					totalItems += e.Count

					// Estimate progress: start at 5%, scale up to 90% based on events seen.
					// Cloud providers emit ~5-15 events, NIOS emits ~5 events.
					// Use a factor that reaches ~90% after ~10 events.
					progress := 5 + eventCount*9
					if progress > 90 {
						progress = 90
					}
					sess.UpdateProviderProgress(providerName, "running", progress, totalItems)
				}
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

				sess.UpdateProviderProgress(providerName, "error", 100, totalItems)

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

				sess.UpdateProviderProgress(providerName, "complete", 100, totalItems)

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
		Provider:       p.Provider,
		Subscriptions:  append([]string(nil), p.Subscriptions...),
		SelectionMode:  p.SelectionMode,
		Credentials:    make(map[string]string),
		MaxWorkers:     p.MaxWorkers,
		RequestTimeout: p.RequestTimeout,
		CheckpointPath: p.CheckpointPath,
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
			req.Credentials["source_profile"] = sess.AWS.SourceProfile
			req.Credentials["external_id"] = sess.AWS.ExternalID
			if sess.AWS.OrgEnabled {
				req.Credentials["org_enabled"] = "true"
			}
			req.Credentials["org_role_name"] = sess.AWS.OrgRoleName
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
			req.Credentials["workload_identity_json"] = sess.GCP.WorkloadIdentityJSON
			req.Credentials["project_id"] = sess.GCP.ProjectID
			req.Credentials["org_id"] = sess.GCP.OrgID
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
			req.Credentials["realm"] = sess.AD.Realm
			req.Credentials["kdc"] = sess.AD.KDC
			if sess.AD.UseSSL {
				req.Credentials["use_ssl"] = "true"
			}
			if sess.AD.InsecureSkipVerify {
				req.Credentials["insecure_skip_verify"] = "true"
			}
		}
	case scanner.ProviderNIOS:
		if p.Mode == "wapi" {
			// WAPI live scan: populate credentials from session.NiosWAPI.
			if sess.NiosWAPI != nil {
				req.Credentials["wapi_url"] = sess.NiosWAPI.URL
				req.Credentials["wapi_username"] = sess.NiosWAPI.Username
				req.Credentials["wapi_password"] = sess.NiosWAPI.Password
				req.Credentials["wapi_version"] = sess.NiosWAPI.ExplicitVersion
				if sess.NiosWAPI.SkipTLS {
					req.Credentials["skip_tls"] = "true"
				}
			}
			// Selected members passed as subscriptions for the WAPI scanner.
			req.Subscriptions = append([]string(nil), p.SelectedMembers...)
		} else {
			// Backup mode: BackupPath and SelectedMembers are set directly on
			// ScanProviderRequest by HandleStartScan after resolving the BackupToken.
			req.Credentials["backup_path"] = p.BackupPath
			req.Credentials["selected_members"] = strings.Join(p.SelectedMembers, ",")
		}
	case scanner.ProviderBluecat:
		if sess.Bluecat != nil {
			req.Credentials["bluecat_url"] = sess.Bluecat.URL
			req.Credentials["bluecat_username"] = sess.Bluecat.Username
			req.Credentials["bluecat_password"] = sess.Bluecat.Password
			if sess.Bluecat.SkipTLS {
				req.Credentials["skip_tls"] = "true"
			}
			if len(sess.Bluecat.ConfigurationIDs) > 0 {
				req.Credentials["configuration_ids"] = strings.Join(sess.Bluecat.ConfigurationIDs, ",")
			}
		}
	case scanner.ProviderEfficientIP:
		if sess.EfficientIP != nil {
			req.Credentials["efficientip_url"] = sess.EfficientIP.URL
			req.Credentials["efficientip_username"] = sess.EfficientIP.Username
			req.Credentials["efficientip_password"] = sess.EfficientIP.Password
			if sess.EfficientIP.SkipTLS {
				req.Credentials["skip_tls"] = "true"
			}
			if len(sess.EfficientIP.SiteIDs) > 0 {
				req.Credentials["site_ids"] = strings.Join(sess.EfficientIP.SiteIDs, ",")
			}
		}
	}

	return req
}
