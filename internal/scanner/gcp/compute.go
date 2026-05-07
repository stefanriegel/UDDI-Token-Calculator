package gcp

import (
	"context"

	compute "cloud.google.com/go/compute/apiv1"
	"cloud.google.com/go/compute/apiv1/computepb"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/protobuf/proto"
)

// countNetworks returns the number of VPC networks in the project.
// Uses the Networks.List REST API (global, not regional).
func countNetworks(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewNetworksRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	it := client.List(ctx, &computepb.ListNetworksRequest{Project: projectID})
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

// countSubnets returns the total number of subnetworks across all regions in the project.
// Uses AggregatedList to enumerate subnets across all regions in a single API call.
func countSubnets(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewSubnetworksRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListSubnetworksRequest{
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
			total += len(pair.Value.Subnetworks)
		}
	}
	return total, nil
}

// countInstances returns the number of RUNNING compute instances across all zones in the project.
// Uses AggregatedList with a RUNNING status filter.
func countInstances(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewInstancesRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListInstancesRequest{
		Project:              projectID,
		Filter:               proto.String(`status = "RUNNING"`),
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
			total += len(pair.Value.Instances)
		}
	}
	return total, nil
}

// countInstanceIPs returns the total number of IP addresses assigned to RUNNING compute instances.
// Both internal (NetworkIP) and external (NatIP per AccessConfig) IPs are counted.
func countInstanceIPs(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := compute.NewInstancesRESTClient(ctx, opts...)
	if err != nil {
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	req := &computepb.AggregatedListInstancesRequest{
		Project:              projectID,
		Filter:               proto.String(`status = "RUNNING"`),
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
			for _, inst := range pair.Value.Instances {
				total += countGCPInstanceIPs(inst)
			}
		}
	}
	return total, nil
}

// countGCPInstanceIPs counts the number of IP addresses assigned to a single compute instance.
// Counts one internal IP (NetworkIP) per network interface plus one external IP (NatIP) per
// AccessConfig that has a non-empty NatIP.
func countGCPInstanceIPs(instance *computepb.Instance) int {
	count := 0
	for _, ni := range instance.GetNetworkInterfaces() {
		if ni.GetNetworkIP() != "" {
			count++
		}
		for _, ac := range ni.GetAccessConfigs() {
			if ac.GetNatIP() != "" {
				count++
			}
		}
	}
	return count
}
