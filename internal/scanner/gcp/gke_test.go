package gcp

import (
	"context"
	"testing"

	"google.golang.org/api/option"
)

// Compile-time signature assertions — these verify the function signatures match
// the expected pattern: (context.Context, []option.ClientOption, string) (int, error).

// TestCountGKEClusterCIDRs_Stub verifies countGKEClusterCIDRs has the correct signature.
// The function accepts option.ClientOption variadic (via slice) for GKE ClusterManagerClient.
func TestCountGKEClusterCIDRs_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countGKEClusterCIDRs
}

// TestCountSecondarySubnetRanges_Stub verifies countSecondarySubnetRanges has the correct signature.
// Uses AggregatedList on SubnetworksRESTClient, counting SecondaryIpRanges instead of subnets.
func TestCountSecondarySubnetRanges_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countSecondarySubnetRanges
}

// TestIsGKEPermissionDenied verifies the permission denial detection helper.
func TestIsGKEPermissionDenied(t *testing.T) {
	// nil error is not a permission denial.
	if isGKEPermissionDenied(nil) {
		t.Fatal("nil error should not be treated as permission denied")
	}
}
