package aws

import (
	"context"

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
