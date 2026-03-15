package aws

import (
	"context"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
)

// scanElasticIPs returns the total number of allocated Elastic IP addresses in this region.
// Each EIP is counted as an Active IP (Address) per the Engineering token spreadsheet.
func scanElasticIPs(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	out, err := client.DescribeAddresses(ctx, &ec2.DescribeAddressesInput{})
	if err != nil {
		return 0, err
	}
	return len(out.Addresses), nil
}

// scanNATGateways returns the total number of NAT Gateways in this region.
// NAT Gateways are counted as Managed Assets per the Engineering token spreadsheet.
func scanNATGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	paginator := ec2.NewDescribeNatGatewaysPaginator(client, &ec2.DescribeNatGatewaysInput{})
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

// scanTransitGateways returns the total number of Transit Gateways in this region.
// Transit Gateways are counted as Managed Assets per the Engineering token spreadsheet.
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

// scanVPNGateways returns the total number of VPN Gateways in this region.
// VPN Gateways are counted as Managed Assets per the Engineering token spreadsheet.
// DescribeVpnGateways is not paginated — AWS returns all VGWs in a single response.
func scanVPNGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	out, err := client.DescribeVpnGateways(ctx, &ec2.DescribeVpnGatewaysInput{})
	if err != nil {
		return 0, err
	}
	return len(out.VpnGateways), nil
}

// scanCustomerGateways returns the total number of Customer Gateways in this region.
// Customer Gateways are counted as Managed Assets per the Engineering token spreadsheet.
// DescribeCustomerGateways is not paginated.
func scanCustomerGateways(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := ec2.NewFromConfig(cfg)
	out, err := client.DescribeCustomerGateways(ctx, &ec2.DescribeCustomerGatewaysInput{})
	if err != nil {
		return 0, err
	}
	return len(out.CustomerGateways), nil
}
