// Package aws implements scanner.Scanner for Amazon Web Services.
// It discovers VPCs, subnets, Route53 hosted zones and record sets, EC2 instances
// (with full IP enumeration), and elbv2 load balancers across all enabled regions.
package aws

import (
	"context"
	"fmt"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Scanner implements scanner.Scanner for AWS.
type Scanner struct{}

// New returns a ready-to-use AWS Scanner.
func New() *Scanner { return &Scanner{} }

// Scan satisfies scanner.Scanner. It:
//  1. Builds an aws.Config from req.Credentials (auth_method routing)
//  2. Calls sts:GetCallerIdentity to get the account ID (used as Source in FindingRows)
//  3. Scans Route53 globally (hosted zones + record sets)
//  4. Enumerates all enabled regions and fans out per-region scans with semaphore
//  5. Returns all FindingRows and any per-provider error
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	baseCfg, err := buildConfig(ctx, req.Credentials)
	if err != nil {
		return nil, fmt.Errorf("aws: build config: %w", err)
	}

	// Get account ID for FindingRow.Source.
	accountID, err := getAccountID(ctx, baseCfg)
	if err != nil {
		return nil, fmt.Errorf("aws: get account id: %w", err)
	}

	var findings []calculator.FindingRow

	// Route53 is a global service — scan once with the bootstrap region config.
	r53Findings := scanRoute53(ctx, baseCfg, accountID, publish)
	findings = append(findings, r53Findings...)

	// Enumerate enabled regions and scan each in parallel (with semaphore).
	regions, err := listEnabledRegions(ctx, baseCfg)
	if err != nil {
		return findings, fmt.Errorf("aws: list regions: %w", err)
	}

	regionalFindings := scanAllRegions(ctx, baseCfg, regions, accountID, publish)
	findings = append(findings, regionalFindings...)

	return findings, nil
}

// buildConfig constructs an aws.Config from the credential map.
// auth_method values: "access_key" | "profile" | "sso" | "assume_role"
// For all paths: adaptive retry (5 attempts) and explicit region are set.
func buildConfig(ctx context.Context, creds map[string]string) (awssdk.Config, error) {
	region := creds["region"]
	if region == "" {
		region = "us-east-1"
	}

	retryOpts := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRetryMaxAttempts(5),
		awsconfig.WithRetryMode(awssdk.RetryModeAdaptive),
		awsconfig.WithRegion(region),
	}

	switch creds["auth_method"] {
	case "access_key", "":
		keyID := creds["access_key_id"]
		secret := creds["secret_access_key"]
		if keyID == "" || secret == "" {
			return awssdk.Config{}, fmt.Errorf("access_key_id and secret_access_key are required")
		}
		return awsconfig.LoadDefaultConfig(ctx,
			append(retryOpts,
				awsconfig.WithCredentialsProvider(
					credentials.NewStaticCredentialsProvider(keyID, secret, ""),
				),
			)...,
		)

	case "profile", "sso":
		// SSO uses LoadDefaultConfig with a named profile that points to an SSO config.
		// The ~/.aws/sso/cache token must already exist (user ran `aws sso login` first).
		profile := creds["profile_name"]
		opts := append(retryOpts, awsconfig.WithSharedConfigProfile(profile))
		return awsconfig.LoadDefaultConfig(ctx, opts...)

	case "assume_role":
		// Build base config first (access_key), then AssumeRole.
		baseCfg, err := buildConfig(ctx, map[string]string{
			"auth_method":       "access_key",
			"access_key_id":     creds["access_key_id"],
			"secret_access_key": creds["secret_access_key"],
			"region":            region,
		})
		if err != nil {
			return awssdk.Config{}, fmt.Errorf("assume_role base config: %w", err)
		}
		stsClient := sts.NewFromConfig(baseCfg)
		result, err := stsClient.AssumeRole(ctx, &sts.AssumeRoleInput{
			RoleArn:         awssdk.String(creds["role_arn"]),
			RoleSessionName: awssdk.String("uddi-go-token-calculator"),
		})
		if err != nil {
			return awssdk.Config{}, fmt.Errorf("assume_role: %w", err)
		}
		return awsconfig.LoadDefaultConfig(ctx,
			append(retryOpts,
				awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
					*result.Credentials.AccessKeyId,
					*result.Credentials.SecretAccessKey,
					*result.Credentials.SessionToken,
				)),
			)...,
		)

	default:
		return awssdk.Config{}, fmt.Errorf("unknown auth_method: %q", creds["auth_method"])
	}
}

// getAccountID calls sts:GetCallerIdentity and returns the AWS account ID.
func getAccountID(ctx context.Context, cfg awssdk.Config) (string, error) {
	client := sts.NewFromConfig(cfg)
	out, err := client.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return "", err
	}
	if out.Account == nil {
		return "unknown", nil
	}
	return *out.Account, nil
}
