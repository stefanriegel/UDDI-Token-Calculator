package gcp

import (
	"context"
	"fmt"

	compute "cloud.google.com/go/compute/apiv1"
	"cloud.google.com/go/compute/apiv1/computepb"
	networkconnectivity "cloud.google.com/go/networkconnectivity/apiv1"
	networkconnectivitypb "cloud.google.com/go/networkconnectivity/apiv1/networkconnectivitypb"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/protobuf/proto"
)

// countAddresses returns the total number of static (reserved) IP addresses across all regions.
// Each address is counted as an Active IP per the Engineering token spreadsheet.
func countAddresses(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewAddressesRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListAddressesRequest{
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
			total += len(pair.Value.Addresses)
		}
	}
	return total, nil
}

// countRouters returns the total number of Cloud Routers across all regions.
// Routers are counted as Managed Assets per the Engineering token spreadsheet.
func countRouters(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewRoutersRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListRoutersRequest{
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
			total += len(pair.Value.Routers)
		}
	}
	return total, nil
}

// countVPNGateways returns the total number of VPN Gateways (HA VPN) across all regions.
// VPN Gateways are counted as Managed Assets per the Engineering token spreadsheet.
func countVPNGateways(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewVpnGatewaysRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListVpnGatewaysRequest{
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
			total += len(pair.Value.VpnGateways)
		}
	}
	return total, nil
}

// countForwardingRules returns the total number of forwarding rules (load balancer frontends)
// across all regions. Forwarding rules are counted as Managed Assets per the Engineering
// token spreadsheet (they represent GCP load balancers).
func countForwardingRules(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewForwardingRulesRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListForwardingRulesRequest{
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
			total += len(pair.Value.ForwardingRules)
		}
	}
	return total, nil
}

// countInternalRanges returns the total number of Internal Ranges in the project.
// Internal Ranges are projected as Address Blocks (DDI Objects) per the Engineering
// token spreadsheet. They are "included by default, can't be excluded".
// Uses the Network Connectivity API (not compute).
func countInternalRanges(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := networkconnectivity.NewInternalRangeClient(ctx, opts...)
	if err != nil {
		return 0, fmt.Errorf("internal ranges: %w", wrapGCPError(err))
	}
	defer client.Close()

	req := &networkconnectivitypb.ListInternalRangesRequest{
		Parent: fmt.Sprintf("projects/%s/locations/global", projectID),
	}
	it := client.ListInternalRanges(ctx, req)
	total := 0
	for {
		_, err := it.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return total, fmt.Errorf("internal ranges: %w", wrapGCPError(err))
		}
		total++
	}
	return total, nil
}
