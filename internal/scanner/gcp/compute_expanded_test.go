package gcp

import (
	"context"
	"testing"

	"google.golang.org/api/option"
)

// Compile-time signature assertions — these verify the function signatures match
// the expected pattern: (context.Context, []option.ClientOption, string) (int, error).

// TestCountAddresses_Stub verifies countAddresses has the correct signature (compile-time).
// countAddresses uses AggregatedList to count reserved IP addresses across all regions.
func TestCountAddresses_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countAddresses
}

// TestCountFirewalls_Stub verifies countFirewalls has the correct signature (compile-time).
// countFirewalls uses List (not AggregatedList) because firewalls are global resources.
func TestCountFirewalls_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countFirewalls
}

// TestCountRouters_Stub verifies countRouters has the correct signature (compile-time).
// countRouters uses AggregatedList to count Cloud Routers across all regions.
func TestCountRouters_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countRouters
}

// TestCountVPNGateways_Stub verifies countVPNGateways has the correct signature (compile-time).
// countVPNGateways uses AggregatedList to count HA VPN gateways across all regions.
func TestCountVPNGateways_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countVPNGateways
}

// TestCountVPNTunnels_Stub verifies countVPNTunnels has the correct signature (compile-time).
// countVPNTunnels uses AggregatedList to count VPN tunnels across all regions.
func TestCountVPNTunnels_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countVPNTunnels
}
