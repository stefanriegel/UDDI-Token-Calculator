package aws

import (
	"context"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
)

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
