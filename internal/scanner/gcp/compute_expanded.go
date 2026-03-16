package gcp

import (
	"context"

	compute "cloud.google.com/go/compute/apiv1"
	"cloud.google.com/go/compute/apiv1/computepb"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/protobuf/proto"
)

// countFirewalls returns the number of firewall rules in the project.
// Firewalls are global resources (not regional), so uses List instead of AggregatedList.
func countFirewalls(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewFirewallsRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.ListFirewallsRequest{
		Project:              projectID,
		ReturnPartialSuccess: proto.Bool(true),
	}
	it := client.List(ctx, req)
	count := 0
	for {
		_, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return count, wrapGCPError(err)
		}
		count++
	}
	return count, nil
}

// countVPNTunnels returns the total number of VPN tunnels across all regions in the project.
// Uses AggregatedList to enumerate VPN tunnels across all regions in a single API call.
func countVPNTunnels(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewVpnTunnelsRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListVpnTunnelsRequest{
		Project:              projectID,
		ReturnPartialSuccess: proto.Bool(true),
	}
	it := client.AggregatedList(ctx, req)
	total := 0
	for {
		pair, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return total, wrapGCPError(err)
		}
		if pair.Value != nil {
			total += len(pair.Value.VpnTunnels)
		}
	}
	return total, nil
}
