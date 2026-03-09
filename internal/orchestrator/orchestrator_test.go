package orchestrator_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/broker"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	adstub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/ad"
	awsstub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/aws"
	azurestub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/azure"
	gcpstub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/gcp"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// failingScanner is a test helper that always returns an error from Scan.
type failingScanner struct {
	errMsg string
}

func (f *failingScanner) Scan(_ context.Context, _ scanner.ScanRequest, _ func(scanner.Event)) ([]calculator.FindingRow, error) {
	return nil, errors.New(f.errMsg)
}

// slowScanner is a test helper that sleeps until context is cancelled.
type slowScanner struct{}

func (s *slowScanner) Scan(ctx context.Context, _ scanner.ScanRequest, _ func(scanner.Event)) ([]calculator.FindingRow, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(30 * time.Second):
		return nil, nil
	}
}

// newTestSession creates a minimal session with a fresh broker for testing.
func newTestSession() *session.Session {
	return &session.Session{
		ID:     "test-session",
		State:  session.ScanStateScanning,
		Broker: broker.New(),
	}
}

// subscribeBroker subscribes to the broker synchronously and returns a function
// that blocks until all events are collected (channel closed by broker.Close).
// Must be called before Run() to avoid the race where the broker is closed
// before Subscribe is called.
func subscribeBroker(b *broker.Broker) func() []broker.Event {
	ch := b.Subscribe()
	resultCh := make(chan []broker.Event, 1)
	go func() {
		var events []broker.Event
		for e := range ch {
			events = append(events, e)
		}
		resultCh <- events
	}()
	return func() []broker.Event {
		return <-resultCh
	}
}

// TestOrchestratorAllStubs runs all four stub scanners and verifies the orchestrator
// completes without errors and produces a non-negative GrandTotal.
func TestOrchestratorAllStubs(t *testing.T) {
	t.Parallel()

	scanners := map[string]scanner.Scanner{
		"aws":   &awsstub.Stub{},
		"azure": &azurestub.Stub{},
		"gcp":   &gcpstub.Stub{},
		"ad":    &adstub.Stub{},
	}
	o := orchestrator.New(scanners)

	sess := newTestSession()
	// Subscribe synchronously before Run so we collect all events.
	collect := subscribeBroker(sess.Broker)

	providers := []orchestrator.ScanProviderRequest{
		{Provider: "aws"},
		{Provider: "azure"},
		{Provider: "gcp"},
		{Provider: "ad"},
	}

	result := o.Run(context.Background(), sess, providers)
	events := collect()

	if len(result.Errors) != 0 {
		t.Errorf("expected 0 errors, got %d: %v", len(result.Errors), result.Errors)
	}
	if result.TokenResult.GrandTotal < 0 {
		t.Errorf("expected GrandTotal >= 0, got %d", result.TokenResult.GrandTotal)
	}

	// Verify provider_start and provider_complete events for each provider.
	providerStarts := map[string]bool{}
	providerCompletes := map[string]bool{}
	for _, e := range events {
		if e.Type == "provider_start" {
			providerStarts[e.Provider] = true
		}
		if e.Type == "provider_complete" {
			providerCompletes[e.Provider] = true
		}
	}
	for _, p := range []string{"aws", "azure", "gcp", "ad"} {
		if !providerStarts[p] {
			t.Errorf("expected provider_start event for %s", p)
		}
		if !providerCompletes[p] {
			t.Errorf("expected provider_complete event for %s", p)
		}
	}
}

// TestOrchestratorSkipsDisabled registers all four stubs but only enables two.
// It verifies that the two disabled providers' scanners are never invoked.
// (UI-05: a disabled provider is never invoked)
func TestOrchestratorSkipsDisabled(t *testing.T) {
	t.Parallel()

	// Use a failing scanner for disabled providers — if invoked, they'd add errors.
	scanners := map[string]scanner.Scanner{
		"aws":   &awsstub.Stub{},
		"azure": &failingScanner{errMsg: "should not be called"},
		"gcp":   &gcpstub.Stub{},
		"ad":    &failingScanner{errMsg: "should not be called"},
	}
	o := orchestrator.New(scanners)

	sess := newTestSession()
	collect := subscribeBroker(sess.Broker)

	// Only enable aws and gcp.
	providers := []orchestrator.ScanProviderRequest{
		{Provider: "aws"},
		{Provider: "gcp"},
	}

	result := o.Run(context.Background(), sess, providers)
	events := collect()

	if len(result.Errors) != 0 {
		t.Errorf("expected 0 errors (disabled scanners must not run), got %d: %v", len(result.Errors), result.Errors)
	}

	// Verify that only aws and gcp events appear, not azure or ad.
	for _, e := range events {
		if e.Provider == "azure" || e.Provider == "ad" {
			t.Errorf("unexpected event for disabled provider %q: %+v", e.Provider, e)
		}
	}

	// Verify aws and gcp provider_start events are present.
	providerStarts := map[string]bool{}
	for _, e := range events {
		if e.Type == "provider_start" {
			providerStarts[e.Provider] = true
		}
	}
	if !providerStarts["aws"] {
		t.Error("expected provider_start event for aws")
	}
	if !providerStarts["gcp"] {
		t.Error("expected provider_start event for gcp")
	}
}

// TestOrchestratorPartialFailure proves RES-01: one failing provider does not
// prevent the other providers from completing and including their findings.
func TestOrchestratorPartialFailure(t *testing.T) {
	t.Parallel()

	scanners := map[string]scanner.Scanner{
		"aws":   &awsstub.Stub{},
		"azure": &failingScanner{errMsg: "azure API timeout"},
		"gcp":   &gcpstub.Stub{},
		"ad":    &adstub.Stub{},
	}
	o := orchestrator.New(scanners)

	sess := newTestSession()
	collect := subscribeBroker(sess.Broker)

	providers := []orchestrator.ScanProviderRequest{
		{Provider: "aws"},
		{Provider: "azure"},
		{Provider: "gcp"},
		{Provider: "ad"},
	}

	result := o.Run(context.Background(), sess, providers)
	collect() // drain events (not needed for assertions here)

	// Exactly one error for the failing provider.
	if len(result.Errors) != 1 {
		t.Errorf("expected 1 error, got %d: %v", len(result.Errors), result.Errors)
	}
	if len(result.Errors) > 0 && result.Errors[0].Provider != "azure" {
		t.Errorf("expected error from azure, got %q", result.Errors[0].Provider)
	}

	// Working providers produced findings.
	if len(result.TokenResult.Findings) == 0 {
		t.Error("expected non-empty findings from working providers (aws, gcp, ad)")
	}

	// Verify no azure findings are present (failed provider contributed no rows).
	for _, row := range result.TokenResult.Findings {
		if row.Provider == "azure" {
			t.Errorf("did not expect azure findings in partial failure result, got %+v", row)
		}
	}
}

// TestOrchestratorPublishesEvents verifies that provider_start and provider_complete
// events are published for each enabled provider, and that provider_complete
// includes a non-negative DurMS (UI-07).
func TestOrchestratorPublishesEvents(t *testing.T) {
	t.Parallel()

	scanners := map[string]scanner.Scanner{
		"aws": &awsstub.Stub{},
	}
	o := orchestrator.New(scanners)

	sess := newTestSession()
	collect := subscribeBroker(sess.Broker)

	providers := []orchestrator.ScanProviderRequest{
		{Provider: "aws"},
	}

	o.Run(context.Background(), sess, providers)
	events := collect()

	var startEvent, completeEvent *broker.Event
	for i := range events {
		if events[i].Type == "provider_start" && events[i].Provider == "aws" {
			startEvent = &events[i]
		}
		if events[i].Type == "provider_complete" && events[i].Provider == "aws" {
			completeEvent = &events[i]
		}
	}

	if startEvent == nil {
		t.Fatal("expected provider_start event for aws, not found")
	}
	if completeEvent == nil {
		t.Fatal("expected provider_complete event for aws, not found")
	}
	if completeEvent.DurMS < 0 {
		t.Errorf("expected provider_complete DurMS >= 0, got %d", completeEvent.DurMS)
	}
}

// TestOrchestratorPublishesScanComplete verifies that a scan_complete event is
// published after all providers finish and before the broker is closed (UI-04).
// The scan_complete event must have no Provider set — it is a global lifecycle event.
func TestOrchestratorPublishesScanComplete(t *testing.T) {
	t.Parallel()

	scanners := map[string]scanner.Scanner{
		"aws": &awsstub.Stub{},
	}
	o := orchestrator.New(scanners)

	sess := newTestSession()
	collect := subscribeBroker(sess.Broker)

	providers := []orchestrator.ScanProviderRequest{
		{Provider: "aws"},
	}

	o.Run(context.Background(), sess, providers)
	events := collect()

	var scanCompleteEvents []broker.Event
	for _, e := range events {
		if e.Type == "scan_complete" {
			scanCompleteEvents = append(scanCompleteEvents, e)
		}
	}

	if len(scanCompleteEvents) != 1 {
		t.Fatalf("expected exactly 1 scan_complete event, got %d", len(scanCompleteEvents))
	}
	if scanCompleteEvents[0].Provider != "" {
		t.Errorf("expected scan_complete event to have no Provider, got %q", scanCompleteEvents[0].Provider)
	}
}

// TestOrchestratorContextCancel verifies that cancelling the context mid-scan
// causes the orchestrator to return promptly without hanging. Scanners that
// honour ctx.Done() exit early.
func TestOrchestratorContextCancel(t *testing.T) {
	t.Parallel()

	scanners := map[string]scanner.Scanner{
		"aws": &slowScanner{},
		"gcp": &slowScanner{},
	}
	o := orchestrator.New(scanners)

	sess := newTestSession()
	// Subscribe before Run to avoid race, but we don't need events.
	collect := subscribeBroker(sess.Broker)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		providers := []orchestrator.ScanProviderRequest{
			{Provider: "aws"},
			{Provider: "gcp"},
		}
		o.Run(ctx, sess, providers)
		close(done)
	}()

	// Cancel after a short delay to let goroutines start.
	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// Run returned promptly after cancel — pass.
	case <-time.After(5 * time.Second):
		t.Error("orchestrator did not return within 5 seconds after context cancel")
	}

	collect() // drain to unblock broker goroutine
}
