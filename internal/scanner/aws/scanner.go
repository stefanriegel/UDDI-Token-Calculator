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
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/sso"
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
	// For SSO auth, inject the first selected account ID into the credentials map
	// so buildConfig can call sso:GetRoleCredentials for the correct account.
	// A shallow copy is used to avoid mutating the caller's map.
	creds := make(map[string]string, len(req.Credentials))
	for k, v := range req.Credentials {
		creds[k] = v
	}
	if creds["auth_method"] == "sso" && len(req.Subscriptions) > 0 && creds["sso_account_id"] == "" {
		creds["sso_account_id"] = req.Subscriptions[0]
	}

	baseCfg, err := buildConfig(ctx, creds)
	if err != nil {
		return nil, fmt.Errorf("aws: build config: %w", err)
	}

	// Get account ID for FindingRow.Source.
	accountID, err := getAccountID(ctx, baseCfg)
	if err != nil {
		return nil, fmt.Errorf("aws: get account id: %w", err)
	}

	// Resolve a human-friendly account name (alias or fallback).
	accountName := getAccountName(ctx, baseCfg, accountID)

	var findings []calculator.FindingRow

	// Route53 is a global service — scan once with the bootstrap region config.
	r53Findings := scanRoute53(ctx, baseCfg, accountName, publish)
	findings = append(findings, r53Findings...)

	// Enumerate enabled regions and scan each in parallel (with semaphore).
	regions, err := listEnabledRegions(ctx, baseCfg)
	if err != nil {
		return findings, fmt.Errorf("aws: list regions: %w", err)
	}

	regionalFindings := scanAllRegions(ctx, baseCfg, regions, accountName, publish)
	findings = append(findings, regionalFindings...)

	return findings, nil
}

// buildConfig constructs an aws.Config from the credential map.
// auth_method values: "access_key" | "access-key" | "profile" | "sso" | "assume_role" | "assume-role"
// Hyphenated variants ("access-key", "assume-role") are accepted as aliases for the
// underscore forms so that the frontend's kebab-case auth method IDs work without
// a mapping step.
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
	case "access_key", "access-key", "":
		keyID := creds["access_key_id"]
		secret := creds["secret_access_key"]
		if keyID == "" || secret == "" {
			return awssdk.Config{}, fmt.Errorf("access_key_id and secret_access_key are required")
		}
		return awsconfig.LoadDefaultConfig(ctx,
			append(retryOpts,
				awsconfig.WithCredentialsProvider(
					credentials.NewStaticCredentialsProvider(keyID, secret, creds["session_token"]),
				),
			)...,
		)

	case "profile":
		// Profile uses LoadDefaultConfig with a named profile from ~/.aws/config.
		profile := creds["profile_name"]
		opts := append(retryOpts, awsconfig.WithSharedConfigProfile(profile))
		return awsconfig.LoadDefaultConfig(ctx, opts...)

	case "sso":
		// SSO uses the access token obtained during the OIDC device-authorization flow
		// (stored in sso_access_token) to call sso:GetRoleCredentials for the target
		// account. This avoids requiring a pre-configured ~/.aws/config SSO profile.
		accessToken := creds["sso_access_token"]
		ssoRegion := creds["sso_region"]
		accountID := creds["sso_account_id"]
		if accessToken == "" {
			return awssdk.Config{}, fmt.Errorf("sso_access_token is required for SSO scanning (re-validate your SSO credentials)")
		}
		if ssoRegion == "" {
			ssoRegion = region // fall back to the main region if sso_region is unset
		}

		// Build a bootstrap config (no credentials needed — just region) to create the SSO client.
		ssoCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(ssoRegion))
		if err != nil {
			return awssdk.Config{}, fmt.Errorf("sso bootstrap config: %w", err)
		}
		ssoClient := sso.NewFromConfig(ssoCfg)

		// List the roles available for this account and pick the first one.
		// In most enterprise setups there is exactly one read-only scanner role per account.
		rolesOut, err := ssoClient.ListAccountRoles(ctx, &sso.ListAccountRolesInput{
			AccessToken: awssdk.String(accessToken),
			AccountId:   awssdk.String(accountID),
		})
		if err != nil {
			return awssdk.Config{}, fmt.Errorf("sso: list account roles for %s: %w", accountID, err)
		}
		if len(rolesOut.RoleList) == 0 {
			return awssdk.Config{}, fmt.Errorf("sso: no roles available for account %s", accountID)
		}
		roleName := awssdk.ToString(rolesOut.RoleList[0].RoleName)

		// Exchange the SSO token for temporary STS credentials.
		credsOut, err := ssoClient.GetRoleCredentials(ctx, &sso.GetRoleCredentialsInput{
			AccessToken: awssdk.String(accessToken),
			AccountId:   awssdk.String(accountID),
			RoleName:    awssdk.String(roleName),
		})
		if err != nil {
			return awssdk.Config{}, fmt.Errorf("sso: get role credentials for %s/%s: %w", accountID, roleName, err)
		}
		rc := credsOut.RoleCredentials
		return awsconfig.LoadDefaultConfig(ctx,
			append(retryOpts,
				awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
					awssdk.ToString(rc.AccessKeyId),
					awssdk.ToString(rc.SecretAccessKey),
					awssdk.ToString(rc.SessionToken),
				)),
			)...,
		)

	case "assume_role", "assume-role":
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

// getAccountName resolves a human-friendly name for an AWS account.
// It calls iam:ListAccountAliases and returns the first alias if one exists.
// On any error or empty alias list, falls back to "AWS Account {accountID}".
// This matches the validate endpoint pattern which returns "AWS Account " + account.
func getAccountName(ctx context.Context, cfg awssdk.Config, accountID string) string {
	client := iam.NewFromConfig(cfg)
	out, err := client.ListAccountAliases(ctx, &iam.ListAccountAliasesInput{
		MaxItems: awssdk.Int32(1),
	})
	if err == nil && len(out.AccountAliases) > 0 && out.AccountAliases[0] != "" {
		return out.AccountAliases[0]
	}
	return "AWS Account " + accountID
}
