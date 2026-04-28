package aws

import (
	"context"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/elasticloadbalancingv2"
)

// scanLoadBalancers returns the total number of ALB, NLB, and GWLB load balancers
// using the elbv2 DescribeLoadBalancers paginator.
// Classic Load Balancers (ELBv1) are intentionally excluded — user decision in CONTEXT.md.
func scanLoadBalancers(ctx context.Context, cfg awssdk.Config) (int, error) {
	client := elasticloadbalancingv2.NewFromConfig(cfg)
	paginator := elasticloadbalancingv2.NewDescribeLoadBalancersPaginator(client, &elasticloadbalancingv2.DescribeLoadBalancersInput{})
	count := 0
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.LoadBalancers)
	}
	return count, nil
}
