package aws

import (
	"context"
	"strings"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// scanVPCs returns the total number of VPCs in this region using the DescribeVpcs paginator.
func scanVPCs(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeVpcsPaginator(client, &ec2.DescribeVpcsInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.Vpcs)
	}
	return count, nil
}

// scanSubnets returns the total number of subnets in this region.
func scanSubnets(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeSubnetsPaginator(client, &ec2.DescribeSubnetsInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.Subnets)
	}
	return count, nil
}

// scanInstanceCount returns the number of non-terminated EC2 instances.
// No state filter is passed — AWS default behavior excludes terminated instances.
// Counts: running, stopped, stopping, pending.
func scanInstanceCount(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeInstancesPaginator(client, &ec2.DescribeInstancesInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		for _, r := range page.Reservations {
			count += len(r.Instances)
		}
	}
	return count, nil
}

// scanInstanceIPs returns the total IP count (private + public) across all instances.
// Uses countInstanceIPs for the per-page accumulation.
func scanInstanceIPs(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeInstancesPaginator(client, &ec2.DescribeInstancesInput{})
	total := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return total, err
		}
		total += countInstanceIPs(page.Reservations)
	}
	return total, nil
}

// scanElasticIPs returns the number of Elastic IP addresses in this region.
// DescribeAddresses is a single-call API (no paginator).
func scanElasticIPs(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	out, err := client.DescribeAddresses(ctx, &ec2.DescribeAddressesInput{})
	if err != nil {
		return 0, err
	}
	return len(out.Addresses), nil
}

// scanNATGateways returns the count of non-deleted NAT gateways in this region.
// Filters out "deleted" state so we only count pending/failed/available/deleting.
func scanNATGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeNatGatewaysPaginator(client, &ec2.DescribeNatGatewaysInput{
		Filter: []ec2types.Filter{
			{
				Name:   awssdk.String("state"),
				Values: []string{"pending", "failed", "available", "deleting"},
			},
		},
	})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.NatGateways)
	}
	return count, nil
}

// scanTransitGateways returns the total number of transit gateways in this region.
func scanTransitGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeTransitGatewaysPaginator(client, &ec2.DescribeTransitGatewaysInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.TransitGateways)
	}
	return count, nil
}

// scanInternetGateways returns the total number of internet gateways in this region.
func scanInternetGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeInternetGatewaysPaginator(client, &ec2.DescribeInternetGatewaysInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.InternetGateways)
	}
	return count, nil
}

// scanRouteTables returns the total number of route tables in this region.
func scanRouteTables(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeRouteTablesPaginator(client, &ec2.DescribeRouteTablesInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.RouteTables)
	}
	return count, nil
}

// scanSecurityGroups returns the total number of security groups in this region.
func scanSecurityGroups(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeSecurityGroupsPaginator(client, &ec2.DescribeSecurityGroupsInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.SecurityGroups)
	}
	return count, nil
}

// scanVPNGateways returns the count of non-deleted VPN gateways in this region.
// DescribeVpnGateways is a single-call API (no paginator).
// Filters out "deleted" state.
func scanVPNGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	out, err := client.DescribeVpnGateways(ctx, &ec2.DescribeVpnGatewaysInput{
		Filters: []ec2types.Filter{
			{
				Name:   awssdk.String("state"),
				Values: []string{"pending", "available", "deleting"},
			},
		},
	})
	if err != nil {
		return 0, err
	}
	return len(out.VpnGateways), nil
}

// scanIPAMPools returns the total number of IPAM pools in this region.
// Gracefully returns 0 if IPAM is not enabled (the API may return an error).
func scanIPAMPools(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeIpamPoolsPaginator(client, &ec2.DescribeIpamPoolsInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			msg := err.Error()
			if strings.Contains(msg, "IPAM") || strings.Contains(msg, "not enabled") || strings.Contains(msg, "InvalidParameterValue") {
				return 0, nil
			}
			return count, err
		}
		count += len(page.IpamPools)
	}
	return count, nil
}

// scanVPCCIDRBlocks counts the total number of CIDR block associations across all VPCs.
// This counts CidrBlockAssociationSet entries per VPC (not VPC count itself).
func scanVPCCIDRBlocks(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeVpcsPaginator(client, &ec2.DescribeVpcsInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		for _, vpc := range page.Vpcs {
			count += len(vpc.CidrBlockAssociationSet)
		}
	}
	return count, nil
}

// countInstanceIPs counts all private and public IPs for a slice of reservations.
// Primary path: iterates NetworkInterfaces[].PrivateIpAddresses[]; counts associated public IPs.
// Fallback path (empty NetworkInterfaces): uses top-level PrivateIpAddress + PublicIpAddress.
// Matches the Python reference _count_instance_ips() logic exactly.
func countInstanceIPs(reservations []ec2types.Reservation) int {
	total := 0
	for _, r := range reservations {
		for _, inst := range r.Instances {
			ifaces := inst.NetworkInterfaces
			if len(ifaces) == 0 {
				// Fallback: instance launched without explicit ENI configuration.
				if inst.PrivateIpAddress != nil {
					total++
				}
				if inst.PublicIpAddress != nil {
					total++
				}
				continue
			}
			for _, iface := range ifaces {
				pips := iface.PrivateIpAddresses
				if len(pips) > 0 {
					total += len(pips)
					for _, pip := range pips {
						if pip.Association != nil && pip.Association.PublicIp != nil {
							total++
						}
					}
				} else {
					// Interface has no PrivateIpAddresses slice — use top-level interface fields.
					if iface.PrivateIpAddress != nil {
						total++
					}
					if iface.Association != nil && iface.Association.PublicIp != nil {
						total++
					}
				}
			}
		}
	}
	return total
}
