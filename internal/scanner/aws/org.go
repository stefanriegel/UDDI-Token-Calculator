package aws

import (
	"context"
	"fmt"
	"strings"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/organizations"
	orgtypes "github.com/aws/aws-sdk-go-v2/service/organizations/types"
	"github.com/infoblox/uddi-go-token-calculator/internal/cloudutil"
)

// AccountInfo describes a single AWS account discovered via Organizations.
type AccountInfo struct {
	ID     string
	Name   string
	Status string
}

// organizationsAPI is the subset of the Organizations client used by DiscoverAccounts.
// Defined as an interface for testability.
type organizationsAPI interface {
	ListAccounts(ctx context.Context, params *organizations.ListAccountsInput, optFns ...func(*organizations.Options)) (*organizations.ListAccountsOutput, error)
}

// DiscoverAccounts calls Organizations ListAccounts in us-east-1 and returns all
// ACTIVE accounts. API calls are wrapped in CallWithBackoff for throttle resilience.
func DiscoverAccounts(ctx context.Context, cfg awssdk.Config) ([]AccountInfo, error) {
	// Organizations API is only available in us-east-1.
	orgCfg := configForRegion(cfg, "us-east-1")
	client := organizations.NewFromConfig(orgCfg)
	return discoverAccountsWithClient(ctx, client)
}

// discoverAccountsWithClient is the testable core — accepts the organizationsAPI interface.
func discoverAccountsWithClient(ctx context.Context, client organizationsAPI) ([]AccountInfo, error) {
	var accounts []AccountInfo
	var nextToken *string

	for {
		token := nextToken // capture for closure
		out, err := cloudutil.CallWithBackoff(ctx, func() (*organizations.ListAccountsOutput, error) {
			return client.ListAccounts(ctx, &organizations.ListAccountsInput{
				NextToken: token,
			})
		}, cloudutil.BackoffOptions{
			MaxRetries: 5,
			IsRetryable: func(err error) bool {
				// Retry on throttling (TooManyRequestsException) and transient errors.
				msg := err.Error()
				return strings.Contains(msg, "TooManyRequests") ||
					strings.Contains(msg, "Throttling") ||
					strings.Contains(msg, "ServiceException") ||
					strings.Contains(msg, "throttling")
			},
		})
		if err != nil {
			return nil, fmt.Errorf("organizations ListAccounts: %w", err)
		}

		for _, acct := range out.Accounts {
			if acct.Status != orgtypes.AccountStatusActive {
				continue
			}
			accounts = append(accounts, AccountInfo{
				ID:     awssdk.ToString(acct.Id),
				Name:   awssdk.ToString(acct.Name),
				Status: string(acct.Status),
			})
		}

		if out.NextToken == nil {
			break
		}
		nextToken = out.NextToken
	}

	return accounts, nil
}
