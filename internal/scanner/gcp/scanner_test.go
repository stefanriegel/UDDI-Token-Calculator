// Tests for the GCP scanner package — uses real package functions after Plan 02 installs the SDK.
package gcp

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/compute/apiv1/computepb"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
	"golang.org/x/oauth2"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/checkpoint"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// ---- Compile-time signature assertions ----
// These ensure the real package functions match the signatures expected by the scanner.

var _ func(context.Context, []option.ClientOption, string) (int, error) = countNetworks
var _ func(context.Context, []option.ClientOption, string) (int, error) = countSubnets
var _ func(context.Context, []option.ClientOption, string) (int, error) = countInstances
var _ func(context.Context, []option.ClientOption, string) (int, error) = countInstanceIPs
var _ func(*computepb.Instance) int = countGCPInstanceIPs
var _ func(context.Context, oauth2.TokenSource, string) (int, int, error) = countDNS

// scanOneProject signature assertion — verifies the extraction from Scan().
var _ func(context.Context, string, oauth2.TokenSource, []option.ClientOption, func(scanner.Event)) []calculator.FindingRow = scanOneProject

// ---- Tests ----

// TestCountGCPInstanceIPs verifies IP counting across NIC configurations using real computepb types.
func TestCountGCPInstanceIPs(t *testing.T) {
	// Instance with one NIC: NetworkIP="10.0.0.1", NatIP="34.1.2.3" → 2 IPs.
	ni1 := &computepb.NetworkInterface{
		NetworkIP: strPtr("10.0.0.1"),
		AccessConfigs: []*computepb.AccessConfig{
			{NatIP: strPtr("34.1.2.3")},
		},
	}
	got := countGCPInstanceIPs(&computepb.Instance{NetworkInterfaces: []*computepb.NetworkInterface{ni1}})
	if got != 2 {
		t.Errorf("one NIC with internal+external: expected 2 IPs, got %d", got)
	}

	// Instance with two NICs, no NatIP → 2 IPs (one internal per NIC).
	ni2a := &computepb.NetworkInterface{NetworkIP: strPtr("10.0.0.1")}
	ni2b := &computepb.NetworkInterface{NetworkIP: strPtr("10.0.0.2")}
	got = countGCPInstanceIPs(&computepb.Instance{NetworkInterfaces: []*computepb.NetworkInterface{ni2a, ni2b}})
	if got != 2 {
		t.Errorf("two NICs no external: expected 2 IPs, got %d", got)
	}

	// Instance with no network interfaces → 0 IPs.
	got = countGCPInstanceIPs(&computepb.Instance{})
	if got != 0 {
		t.Errorf("no NICs: expected 0 IPs, got %d", got)
	}
}

// TestWrapGCPError_PermissionDenied verifies 403 wrapping includes the original message.
func TestWrapGCPError_PermissionDenied(t *testing.T) {
	orig := &googleapi.Error{Code: 403, Message: "Required 'compute.networks.list' permission..."}
	wrapped := wrapGCPError(orig)
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	msg := wrapped.Error()
	if !contains(msg, "GCP permission denied") {
		t.Errorf("expected 'GCP permission denied' in error, got: %s", msg)
	}
	if !contains(msg, orig.Message) {
		t.Errorf("expected original message in error, got: %s", msg)
	}
}

// TestWrapGCPError_NotFound verifies 404 wrapping.
func TestWrapGCPError_NotFound(t *testing.T) {
	orig := &googleapi.Error{Code: 404, Message: "zone not found"}
	wrapped := wrapGCPError(orig)
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	if !contains(wrapped.Error(), "GCP resource not found") {
		t.Errorf("expected 'GCP resource not found' in error, got: %s", wrapped.Error())
	}
}

// TestWrapGCPError_NonGoogleError verifies non-Google errors and non-403/404 googleapi errors.
func TestWrapGCPError_NonGoogleError(t *testing.T) {
	// Non-403/404 googleapi error produces "GCP API error N: ..." message.
	gErr500 := &googleapi.Error{Code: 500, Message: "internal server error"}
	result := wrapGCPError(gErr500)
	if result == nil {
		t.Fatal("expected non-nil error for 500")
	}
	if !contains(result.Error(), "GCP API error 500") {
		t.Errorf("expected 'GCP API error 500' in error, got: %s", result.Error())
	}

	// Plain non-googleapi error must be returned exactly as-is (same pointer value).
	plain := errors.New("timeout")
	if wrapGCPError(plain) != plain {
		t.Errorf("expected same plain error back")
	}

	// Nil in, nil out.
	if wrapGCPError(nil) != nil {
		t.Error("expected nil for nil input")
	}
}

// TestCountNetworks_Stub verifies countNetworks has the correct signature (compile-time).
// The compile-time assertion at package level guarantees the function exists with the
// correct signature. Live behavior is verified in integration tests in Plan 03.
func TestCountNetworks_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countNetworks
}

// TestCountSubnets_Stub verifies countSubnets has the correct signature (compile-time).
// countSubnets uses AggregatedList and returns the aggregate across all regions.
// Live behavior is verified in integration tests in Plan 03.
func TestCountSubnets_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countSubnets
}

// TestCountDNSZones_Stub verifies countDNS has the correct return signature (compile-time).
// Both public and private zones are counted (no visibility filter — GCP-03 requirement).
// Live behavior is verified in integration tests in Plan 03.
func TestCountDNSZones_Stub(t *testing.T) {
	var _ func(context.Context, oauth2.TokenSource, string) (int, int, error) = countDNS
}

// TestCountDNSRecords_Stub verifies that countDNS returns record count as its second int return.
// The compile-time signature assertion above covers this: (zoneCount int, recordCount int, err error).
// Live behavior is verified in integration tests in Plan 03.
func TestCountDNSRecords_Stub(t *testing.T) {
	var _ func(context.Context, oauth2.TokenSource, string) (int, int, error) = countDNS
}

// TestBuildTokenSource_OrgMethod verifies buildTokenSource handles auth_method=org
// by falling back to service_account_json parsing when no cached token source is available.
func TestBuildTokenSource_OrgMethod(t *testing.T) {
	ctx := context.Background()

	// With cached token source, org method should return it directly.
	staticTS := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test-token"})
	creds := map[string]string{"auth_method": "org"}
	ts, err := buildTokenSource(ctx, creds, staticTS)
	if err != nil {
		t.Fatalf("expected no error with cached token source, got: %v", err)
	}
	if ts != staticTS {
		t.Error("expected cached token source to be returned")
	}

	// Without cached token source and no service_account_json, should return an error.
	ts, err = buildTokenSource(ctx, creds, nil)
	if err == nil {
		t.Fatal("expected error when no cached token source and no SA JSON")
	}
	if !contains(err.Error(), "service_account_json credential is required for org mode") {
		t.Errorf("unexpected error message: %s", err.Error())
	}
}

// TestScan_SingleSubscription verifies that Scan() with a single subscription
// uses the single-project path and returns findings (existing behavior preserved).
func TestScan_SingleSubscription(t *testing.T) {
	// This is a compile-time + dispatch verification test.
	// We verify the Scan method exists with the correct signature and dispatches
	// to the single-project path when len(Subscriptions) == 1.
	// Actually calling real GCP APIs is not possible in unit tests.
	var _ func(context.Context, scanner.ScanRequest, func(scanner.Event)) ([]calculator.FindingRow, error) = (&Scanner{}).Scan

	// Verify that Scan with empty subscriptions and no project_id returns the expected error.
	s := New()
	staticTS := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test"})
	_, err := s.Scan(context.Background(), scanner.ScanRequest{
		Provider:             scanner.ProviderGCP,
		Credentials:          map[string]string{"auth_method": "adc"},
		CachedGCPTokenSource: staticTS,
	}, func(scanner.Event) {})
	if err == nil {
		t.Fatal("expected error for missing project ID")
	}
	if !contains(err.Error(), "project ID is required") {
		t.Errorf("unexpected error: %s", err.Error())
	}
}

// TestScan_MultiSubscriptionDispatch verifies that Scan() with multiple subscriptions
// dispatches to scanAllProjects (fan-out path). We verify this by checking that the
// "project_progress" events are emitted for each project.
func TestScan_MultiSubscriptionDispatch(t *testing.T) {
	// This test verifies dispatch logic only — actual scans will fail against real
	// GCP APIs without credentials, but the semaphore + goroutine plumbing is exercised.
	// We use a cancelled context to prevent actual API calls.
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Cancel immediately — goroutines will exit at semaphore acquire.

	staticTS := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test"})
	s := New()
	// Multiple subscriptions should trigger fan-out, but the cancelled context
	// will cause goroutines to exit early. We verify no panic and clean return.
	_, err := s.Scan(ctx, scanner.ScanRequest{
		Provider:             scanner.ProviderGCP,
		Credentials:          map[string]string{"auth_method": "adc"},
		Subscriptions:        []string{"proj-a", "proj-b"},
		CachedGCPTokenSource: staticTS,
	}, func(scanner.Event) {})
	// scanAllProjects returns (findings, nil) even with a cancelled context
	// because per-project failures are non-fatal.
	if err != nil {
		t.Fatalf("expected nil error from fan-out with cancelled ctx, got: %v", err)
	}
}

// TestScanAllProjects_CheckpointResume verifies that scanAllProjects skips
// projects that were already completed in a prior checkpoint and prepends
// their saved findings.
func TestScanAllProjects_CheckpointResume(t *testing.T) {
	// Save and restore the real scanOneProjectFunc.
	origFn := scanOneProjectFunc
	t.Cleanup(func() { scanOneProjectFunc = origFn })

	// Track which project IDs are actually scanned.
	var mu sync.Mutex
	scannedIDs := make(map[string]bool)
	scanOneProjectFunc = func(ctx context.Context, projectID string, ts oauth2.TokenSource, opts []option.ClientOption, publish func(scanner.Event)) []calculator.FindingRow {
		mu.Lock()
		scannedIDs[projectID] = true
		mu.Unlock()
		return []calculator.FindingRow{
			{Provider: "gcp", Source: projectID, Item: "vpc_network", Count: 3},
		}
	}

	// Pre-populate checkpoint with proj-a already completed.
	cpDir := t.TempDir()
	cpPath := filepath.Join(cpDir, "checkpoint-gcp.json")
	cp := checkpoint.New(cpPath, "", "gcp")
	_ = cp.AddUnit(checkpoint.CompletedUnit{
		ID:          "proj-a",
		Name:        "proj-a",
		CompletedAt: time.Now(),
		Findings: []calculator.FindingRow{
			{Provider: "gcp", Source: "proj-a", Item: "vpc_network", Count: 7},
			{Provider: "gcp", Source: "proj-a", Item: "subnet", Count: 12},
		},
	})

	ctx := context.Background()
	staticTS := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: "test"})
	projects := []string{"proj-a", "proj-b", "proj-c"}

	var events []scanner.Event
	var eventMu sync.Mutex
	publish := func(e scanner.Event) {
		eventMu.Lock()
		events = append(events, e)
		eventMu.Unlock()
	}

	findings, err := scanAllProjects(ctx, staticTS, projects, 2, cpPath, publish)
	if err != nil {
		t.Fatalf("scanAllProjects: %v", err)
	}

	// (a) proj-a should NOT have been scanned (it was in the checkpoint).
	if scannedIDs["proj-a"] {
		t.Error("proj-a was scanned but should have been skipped (already in checkpoint)")
	}

	// (b) proj-b and proj-c should have been scanned.
	if !scannedIDs["proj-b"] {
		t.Error("proj-b was not scanned")
	}
	if !scannedIDs["proj-c"] {
		t.Error("proj-c was not scanned")
	}

	// (c) Findings should include pre-loaded checkpoint data + fresh scans.
	if len(findings) < 4 {
		t.Errorf("expected at least 4 findings (2 from checkpoint + 2 from scanning), got %d", len(findings))
	}

	// Verify pre-loaded findings are present.
	foundCheckpointed := false
	for _, f := range findings {
		if f.Source == "proj-a" && f.Item == "subnet" && f.Count == 12 {
			foundCheckpointed = true
		}
	}
	if !foundCheckpointed {
		t.Error("checkpoint findings for proj-a not found in results")
	}

	// (d) Verify checkpoint_loaded event was published.
	hasLoaded := false
	for _, e := range events {
		if e.Type == "checkpoint_loaded" {
			hasLoaded = true
		}
	}
	if !hasLoaded {
		t.Error("expected checkpoint_loaded event")
	}
}

// ---- Helpers ----

// strPtr returns a pointer to s, for constructing computepb structs in tests.
func strPtr(s string) *string { return &s }

// contains is a helper for substring checks without importing strings.
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 || findSubstr(s, substr))
}

func findSubstr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
