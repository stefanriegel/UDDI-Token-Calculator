package gcp

import (
	"context"
	"testing"

	"google.golang.org/api/option"
)

// Compile-time signature assertion for countAddresses — verifies the AggregatedList
// pattern used to count reserved IP addresses across all regions.
func TestCountAddresses_Stub(t *testing.T) {
	var _ func(context.Context, []option.ClientOption, string) (int, error) = countAddresses
}
