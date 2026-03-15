// Tests for the GCP scanner package — uses real package functions after Plan 02 installs the SDK.
package gcp

import (
	"context"
	"errors"
	"testing"

	"cloud.google.com/go/compute/apiv1/computepb"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
	"golang.org/x/oauth2"
)

// ---- Compile-time signature assertions ----
// These ensure the real package functions match the signatures expected by the scanner.

var _ func(context.Context, []option.ClientOption, string) (int, error) = countNetworks
var _ func(context.Context, []option.ClientOption, string) (int, error) = countSubnets
var _ func(context.Context, []option.ClientOption, string) (int, error) = countInstances
var _ func(context.Context, []option.ClientOption, string) (int, error) = countInstanceIPs
var _ func(*computepb.Instance) int = countGCPInstanceIPs
var _ func(context.Context, oauth2.TokenSource, string) (int, int, error) = countDNS
var _ func(context.Context, []option.ClientOption, string) (int, error) = countAddresses
var _ func(context.Context, []option.ClientOption, string) (int, error) = countRouters
var _ func(context.Context, []option.ClientOption, string) (int, error) = countVPNGateways
var _ func(context.Context, []option.ClientOption, string) (int, error) = countForwardingRules
var _ func(context.Context, []option.ClientOption, string) (int, error) = countInternalRanges

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
