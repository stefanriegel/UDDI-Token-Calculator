// Wave 0 test scaffold — all tests use local helper functions so this file compiles
// before Plan 02 installs the GCP compute SDK. TODO(plan-02) comments mark where
// local helpers must be replaced with calls to the real package functions.
package gcp

import (
	"errors"
	"fmt"
	"testing"
)

// ---- Local helper types and functions (Wave 0 isolation) ----

// testNIC represents a network interface card for IP counting tests.
type testNIC struct {
	networkIP   string
	externalIPs []string // NatIPs from AccessConfigs
}

// testCountIPsFromNICs counts internal + external IPs across NICs.
// TODO(plan-02): replace with call to countGCPInstanceIPs once compute.go exists.
func testCountIPsFromNICs(nics []testNIC) int {
	count := 0
	for _, nic := range nics {
		if nic.networkIP != "" {
			count++
		}
		for _, ext := range nic.externalIPs {
			if ext != "" {
				count++
			}
		}
	}
	return count
}

// testCountNetworks returns the number of VPC networks.
// TODO(plan-02): replace with countNetworks (real package function) once compute.go exists.
func testCountNetworks(names []string) int {
	return len(names)
}

// testCountSubnets returns the total number of subnets across all regions.
// TODO(plan-02): replace with countSubnets (real package function) once compute.go exists.
func testCountSubnets(regionSubnets map[string]int) int {
	total := 0
	for _, n := range regionSubnets {
		total += n
	}
	return total
}

// testCountDNSZones returns the total number of DNS zones (public AND private).
// TODO(plan-02): replace with countDNS (real package function) once dns.go exists.
func testCountDNSZones(zones []string) int {
	return len(zones)
}

// testCountDNSRecords returns the total number of DNS records across all zones.
// TODO(plan-02): replace with countDNS (real package function) once dns.go exists.
func testCountDNSRecords(zoneRecordCounts map[string]int) int {
	total := 0
	for _, n := range zoneRecordCounts {
		total += n
	}
	return total
}

// testGoogleAPIError replicates googleapi.Error for Wave 0 test isolation.
type testGoogleAPIError struct {
	Code    int
	Message string
}

func (e *testGoogleAPIError) Error() string { return e.Message }

// testWrapErr replicates wrapGCPError logic for Wave 0 test isolation.
// TODO(plan-02): replace with direct call to wrapGCPError once compute.go exists.
func testWrapErr(err error) error {
	var gErr *testGoogleAPIError
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

// ---- Tests ----

// TestCountGCPInstanceIPs verifies IP counting across NIC configurations.
func TestCountGCPInstanceIPs(t *testing.T) {
	// Instance with one NIC: NetworkIP="10.0.0.1", NatIP="34.1.2.3" → 2 IPs.
	got := testCountIPsFromNICs([]testNIC{
		{networkIP: "10.0.0.1", externalIPs: []string{"34.1.2.3"}},
	})
	if got != 2 {
		t.Errorf("one NIC with internal+external: expected 2 IPs, got %d", got)
	}

	// Instance with two NICs, no NatIP → 2 IPs (one internal per NIC).
	got = testCountIPsFromNICs([]testNIC{
		{networkIP: "10.0.0.1", externalIPs: nil},
		{networkIP: "10.0.0.2", externalIPs: nil},
	})
	if got != 2 {
		t.Errorf("two NICs no external: expected 2 IPs, got %d", got)
	}

	// Instance with no NICs → 0 IPs.
	got = testCountIPsFromNICs([]testNIC{})
	if got != 0 {
		t.Errorf("no NICs: expected 0 IPs, got %d", got)
	}
}

// TestWrapGCPError_PermissionDenied verifies 403 wrapping includes the original message.
func TestWrapGCPError_PermissionDenied(t *testing.T) {
	orig := &testGoogleAPIError{Code: 403, Message: "Required 'compute.networks.list' permission..."}
	wrapped := testWrapErr(orig)
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
	orig := &testGoogleAPIError{Code: 404, Message: "zone not found"}
	wrapped := testWrapErr(orig)
	if wrapped == nil {
		t.Fatal("expected non-nil error")
	}
	if !contains(wrapped.Error(), "GCP resource not found") {
		t.Errorf("expected 'GCP resource not found' in error, got: %s", wrapped.Error())
	}
}

// TestWrapGCPError_NonGoogleError verifies that non-Google errors are returned unchanged.
func TestWrapGCPError_NonGoogleError(t *testing.T) {
	orig := errors.New("timeout")
	result := testWrapErr(orig)
	if result != orig {
		t.Errorf("expected same error value back, got different error: %v", result)
	}
}

// TestCountNetworks_Stub verifies VPC network counting.
func TestCountNetworks_Stub(t *testing.T) {
	// TODO(plan-02): replace testCountNetworks with countNetworks (real package function) once compute.go exists.
	got := testCountNetworks([]string{"default", "vpc-prod", "vpc-dev"})
	if got != 3 {
		t.Errorf("expected 3 networks, got %d", got)
	}
	if testCountNetworks([]string{}) != 0 {
		t.Error("expected 0 networks for empty list")
	}
}

// TestCountSubnets_Stub verifies subnet counting across regions.
func TestCountSubnets_Stub(t *testing.T) {
	// TODO(plan-02): replace testCountSubnets with countSubnets (real package function) once compute.go exists.
	got := testCountSubnets(map[string]int{"us-central1": 2, "europe-west1": 3})
	if got != 5 {
		t.Errorf("expected 5 subnets, got %d", got)
	}
	if testCountSubnets(map[string]int{}) != 0 {
		t.Error("expected 0 subnets for empty map")
	}
}

// TestCountDNSZones_Stub verifies DNS zone counting (public AND private — no visibility filter).
func TestCountDNSZones_Stub(t *testing.T) {
	// TODO(plan-02): replace testCountDNSZones with countDNS (real package function) once dns.go exists.
	// Both public and private zones must be counted (no visibility filter — GCP-03 requirement).
	zones := []string{"public-zone", "private-zone", "internal-zone"}
	got := testCountDNSZones(zones)
	if got != 3 {
		t.Errorf("expected 3 zones (public+private), got %d", got)
	}
	if testCountDNSZones([]string{}) != 0 {
		t.Error("expected 0 zones for empty list")
	}
}

// TestCountDNSRecords_Stub verifies DNS record counting across zones.
func TestCountDNSRecords_Stub(t *testing.T) {
	// TODO(plan-02): replace testCountDNSRecords with countDNS (real package function) once dns.go exists.
	got := testCountDNSRecords(map[string]int{"zone-a": 10, "zone-b": 5})
	if got != 15 {
		t.Errorf("expected 15 records total, got %d", got)
	}
	if testCountDNSRecords(map[string]int{}) != 0 {
		t.Error("expected 0 records for empty map")
	}
}

// contains is a helper to avoid importing strings package inline.
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
