package gcp

import (
	"context"
	"errors"
	"fmt"
	"log"

	compute "cloud.google.com/go/compute/apiv1"
	"cloud.google.com/go/compute/apiv1/computepb"
	container "cloud.google.com/go/container/apiv1"
	"cloud.google.com/go/container/apiv1/containerpb"
	"google.golang.org/api/iterator"
	"google.golang.org/api/option"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
)

// countGKEClusterCIDRs returns the total number of CIDR ranges used by GKE clusters in the project.
// Each cluster contributes 2 CIDRs: one for pods (ClusterIpv4Cidr) and one for services (ServicesIpv4Cidr).
// If the GKE API returns a 403/PermissionDenied, this is treated as a soft failure: returns (0, nil)
// with a warning log, since the caller may lack container.clusters.list permission.
func countGKEClusterCIDRs(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
	client, err := container.NewClusterManagerClient(ctx, opts...)
	if err != nil {
		// Client creation 403 is also a permission issue — treat as soft failure.
		if isGKEPermissionDenied(err) {
			log.Printf("gcp: GKE permission denied for project %s — skipping cluster CIDRs", projectID)
			return 0, nil
		}
		return 0, wrapGCPError(err)
	}
	defer client.Close()

	resp, err := client.ListClusters(ctx, &containerpb.ListClustersRequest{
		Parent: fmt.Sprintf("projects/%s/locations/-", projectID),
	})
	if err != nil {
		if isGKEPermissionDenied(err) {
			log.Printf("gcp: GKE permission denied for project %s — skipping cluster CIDRs", projectID)
			return 0, nil
		}
		return 0, wrapGCPError(err)
	}

	total := 0
	for _, cluster := range resp.GetClusters() {
		if cluster.GetClusterIpv4Cidr() != "" {
			total++
		}
		if cluster.GetServicesIpv4Cidr() != "" {
			total++
		}
	}
	return total, nil
}

// isGKEPermissionDenied returns true if the error represents a permission denial,
// either as a gRPC PermissionDenied status code or a googleapi.Error with code 403.
func isGKEPermissionDenied(err error) bool {
	if err == nil {
		return false
	}
	// gRPC status check (Container API uses gRPC).
	if s, ok := status.FromError(err); ok {
		return s.Code() == codes.PermissionDenied
	}
	// Also check wrapped errors.
	var unwrapped interface{ GRPCStatus() *status.Status }
	if errors.As(err, &unwrapped) {
		return unwrapped.GRPCStatus().Code() == codes.PermissionDenied
	}
	return false
}

// countSecondarySubnetRanges returns the total number of secondary IP ranges across all subnets
// in the project. Uses AggregatedList to enumerate subnets, then sums len(SecondaryIpRanges)
// for each subnet. This differs from countSubnets which counts subnets themselves.
func countSecondarySubnetRanges(ctx context.Context, opts []option.ClientOption, projectID string) (int, error) {
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
			for _, subnet := range pair.Value.Subnetworks {
				total += len(subnet.GetSecondaryIpRanges())
			}
		}
	}
	return total, nil
}
