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
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/broker"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/nios"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
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
	// ForestIndex is used only for the "ad" provider in multi-forest scans.
	// 0 = primary forest (sess.AD), 1+ = sess.ADForests[ForestIndex-1].
	ForestIndex int
	// QPSDataJSON holds JSON-encoded map[string]float64 of peak QPS per member hostname.
	// Resolved from the QPSToken by the server layer. nil if no QPS data was uploaded.
	QPSDataJSON []byte
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

	for _, p := range expandADForests(providers, sess) {
		// Store QPS data in the session before scan starts so post-scan merge can use it.
		if p.Provider == scanner.ProviderNIOS && len(p.QPSDataJSON) > 0 {
			sess.SetNiosQPSDataJSON(p.QPSDataJSON)
		}

		s, ok := o.scanners[selectScannerKey(p)]
		if !ok {
			// Provider not registered — skip silently.
			continue
		}

		wg.Add(1)
		providerName := p.Provider
		req := buildScanRequest(p, sess)

		go func() {
			defer wg.Done()
			rows, perr := runProvider(ctx, sess, providerName, s, req)
			mu.Lock()
			if perr != nil {
				errs = append(errs, *perr)
			} else {
				findings = append(findings, rows...)
			}
			mu.Unlock()
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

// expandADForests appends one ScanProviderRequest per additional AD forest in
// sess.ADForests after each existing AD entry. The primary forest (ForestIndex=0)
// is already present in providers; this only adds extras with ForestIndex 1+.
func expandADForests(providers []ScanProviderRequest, sess *session.Session) []ScanProviderRequest {
	expanded := make([]ScanProviderRequest, 0, len(providers)+len(sess.ADForests))
	for _, p := range providers {
		expanded = append(expanded, p)
		if p.Provider != scanner.ProviderAD {
			continue
		}
		for i := range sess.ADForests {
			expanded = append(expanded, ScanProviderRequest{
				Provider:       scanner.ProviderAD,
				SelectionMode:  p.SelectionMode,
				MaxWorkers:     p.MaxWorkers,
				RequestTimeout: p.RequestTimeout,
				CheckpointPath: p.CheckpointPath,
				ForestIndex:    i + 1, // 1-based: maps to sess.ADForests[i]
			})
		}
	}
	return expanded
}

// selectScannerKey maps a provider request to the scanner-registry key that
// should service it. Most providers map 1:1 to their identifier; NIOS in WAPI
// mode and EfficientIP in backup mode use distinct keys to dispatch to the
// alternate scanner implementation.
func selectScannerKey(p ScanProviderRequest) string {
	switch {
	case p.Provider == scanner.ProviderNIOS && p.Mode == "wapi":
		return "nios-wapi"
	case p.Provider == scanner.ProviderEfficientIP && p.Mode == "backup":
		return "efficientip-backup"
	default:
		return p.Provider
	}
}

// makePublishHandler builds the scanner.Event → broker.Event forwarder used as
// the publish callback for a single provider scan. It also updates per-provider
// progress in the session as resource_progress events arrive.
//
// The returned totalItems closure returns the cumulative item count seen so far,
// used by the caller for the final "complete"/"error" progress update.
func makePublishHandler(sess *session.Session, providerName string) (publish func(scanner.Event), totalItems func() int) {
	eventCount := 0
	items := 0
	publish = func(e scanner.Event) {
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

		if e.Type != "resource_progress" {
			return
		}
		// Estimate progress: start at 5%, scale up to 90% based on events seen.
		// Cloud providers emit ~5-15 events, NIOS emits ~5 events; the factor
		// reaches ~90% after ~10 events.
		eventCount++
		items += e.Count
		progress := 5 + eventCount*9
		if progress > 90 {
			progress = 90
		}
		sess.UpdateProviderProgress(providerName, "running", progress, items)
	}
	totalItems = func() int { return items }
	return publish, totalItems
}

// runProvider drives a single provider scan: publishes provider_start, calls
// s.Scan, publishes the appropriate completion/error event, and threads
// per-provider session updates through the publish handler. Result extraction
// (NIOS metrics, AD per-DC) happens here too.
//
// Returns either the finding rows (success) or a *ProviderError (failure).
// The goroutine in Run merges these into shared accumulators under a mutex.
func runProvider(ctx context.Context, sess *session.Session, providerName string, s scanner.Scanner, req scanner.ScanRequest) ([]calculator.FindingRow, *session.ProviderError) {
	sess.UpdateProviderProgress(providerName, "running", 5, 0)
	sess.Broker.Publish(broker.Event{Type: "provider_start", Provider: providerName})

	publish, totalItems := makePublishHandler(sess, providerName)
	start := time.Now()

	rows, err := s.Scan(ctx, req, publish)
	durMS := time.Since(start).Milliseconds()
	defer sess.Broker.Publish(broker.Event{
		Type:     "provider_complete",
		Provider: providerName,
		DurMS:    durMS,
	})

	if err != nil {
		sess.UpdateProviderProgress(providerName, "error", 100, totalItems())
		sess.Broker.Publish(broker.Event{
			Type:     "error",
			Provider: providerName,
			Message:  err.Error(),
			DurMS:    durMS,
		})
		return nil, &session.ProviderError{Provider: providerName, Message: err.Error()}
	}

	sess.UpdateProviderProgress(providerName, "complete", 100, totalItems())
	attachNiosResults(s, sess)
	attachADResults(s, sess)
	return rows, nil
}

// attachNiosResults pulls per-member metrics JSON from a NIOS scanner result and
// merges any pre-uploaded Splunk QPS data into it. NiosResultScanner is defined
// in internal/scanner/provider.go to avoid an import cycle with internal/scanner/nios.
func attachNiosResults(s scanner.Scanner, sess *session.Session) {
	nrs, ok := s.(scanner.NiosResultScanner)
	if !ok {
		return
	}
	if encoded := nrs.GetNiosServerMetricsJSON(); len(encoded) > 0 {
		sess.SetNiosServerMetricsJSON(mergeQPSIntoMetrics(encoded, sess.NiosQPSDataJSON))
	}
	if encoded := nrs.GetNiosGridFeaturesJSON(); len(encoded) > 0 {
		sess.SetNiosGridFeaturesJSON(encoded)
	}
	if encoded := nrs.GetNiosGridLicensesJSON(); len(encoded) > 0 {
		sess.SetNiosGridLicensesJSON(encoded)
	}
	if encoded := nrs.GetNiosMigrationFlagsJSON(); len(encoded) > 0 {
		sess.SetNiosMigrationFlagsJSON(encoded)
	}
}

// mergeQPSIntoMetrics overlays Splunk QPS values onto the per-member metrics
// before they are used for tier calculations. If qpsJSON is empty or any decode
// fails, the original metrics JSON is returned unchanged.
func mergeQPSIntoMetrics(metricsJSON, qpsJSON []byte) []byte {
	if len(qpsJSON) == 0 {
		return metricsJSON
	}
	var metrics []nios.NiosServerMetric
	var qpsData map[string]float64
	if json.Unmarshal(metricsJSON, &metrics) != nil || json.Unmarshal(qpsJSON, &qpsData) != nil {
		return metricsJSON
	}
	merged := nios.MergeQPSData(metrics, qpsData)
	mergedJSON, err := json.Marshal(merged)
	if err != nil {
		return metricsJSON
	}
	return mergedJSON
}

// attachADResults pulls per-DC metrics JSON from an AD scanner result.
func attachADResults(s scanner.Scanner, sess *session.Session) {
	ars, ok := s.(scanner.ADResultScanner)
	if !ok {
		return
	}
	if encoded := ars.GetADServerMetricsJSON(); len(encoded) > 0 {
		sess.SetADServerMetricsJSON(encoded)
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
		// Resolve which forest's credentials to use based on ForestIndex.
		// ForestIndex=0 → sess.AD (primary), ForestIndex=1+ → sess.ADForests[ForestIndex-1].
		var adCreds *session.ADCredentials
		if p.ForestIndex == 0 {
			adCreds = sess.AD
		} else {
			slot := p.ForestIndex - 1
			if slot < len(sess.ADForests) {
				cpy := sess.ADForests[slot] // copy by value
				adCreds = &cpy
			}
		}
		if adCreds != nil {
			req.Credentials["auth_method"] = adCreds.AuthMethod
			req.Credentials["servers"] = strings.Join(adCreds.Hosts, ",")
			req.Credentials["username"] = adCreds.Username
			req.Credentials["password"] = adCreds.Password
			req.Credentials["domain"] = adCreds.Domain
			req.Credentials["realm"] = adCreds.Realm
			req.Credentials["kdc"] = adCreds.KDC
			if adCreds.UseSSL {
				req.Credentials["use_ssl"] = "true"
			}
			if adCreds.InsecureSkipVerify {
				req.Credentials["insecure_skip_verify"] = "true"
			}
		}
		// Pass selected DCs from the wizard subscriptions list — same pattern as
		// NIOS selected_members. Allows filtering which DCs contribute rows to the
		// report and ensures per-DC source attribution in findings.
		if len(p.Subscriptions) > 0 {
			req.Credentials["selected_dcs"] = strings.Join(p.Subscriptions, ",")
		}
		// Forward cached Azure credential so the AD scanner can enrich
		// findings with Entra ID user/device counts via Microsoft Graph.
		if sess.Azure != nil && sess.Azure.CachedCredential != nil {
			req.CachedAzureCredential = sess.Azure.CachedCredential
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
		if p.Mode == "backup" && p.BackupPath != "" {
			req.Credentials["backup_path"] = p.BackupPath
		} else if sess.EfficientIP != nil {
			req.Credentials["efficientip_url"] = sess.EfficientIP.URL
			req.Credentials["efficientip_username"] = sess.EfficientIP.Username
			req.Credentials["efficientip_password"] = sess.EfficientIP.Password
			if sess.EfficientIP.SkipTLS {
				req.Credentials["skip_tls"] = "true"
			}
			if len(sess.EfficientIP.SiteIDs) > 0 {
				req.Credentials["site_ids"] = strings.Join(sess.EfficientIP.SiteIDs, ",")
			}
			req.Credentials["efficientip_auth_method"] = sess.EfficientIP.AuthMethod
			req.Credentials["efficientip_api_version"] = sess.EfficientIP.APIVersion
			if sess.EfficientIP.AuthMethod == "token" {
				req.Credentials["efficientip_token_id"] = sess.EfficientIP.TokenID
				req.Credentials["efficientip_token_secret"] = sess.EfficientIP.TokenSecret
			}
		}
	}

	return req
}
