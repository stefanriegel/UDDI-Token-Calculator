// Package aws implements scanner.Scanner for Amazon Web Services.
// It discovers VPCs, subnets, Route53 hosted zones and record sets, EC2 instances
// (with full IP enumeration), and elbv2 load balancers across all enabled regions.
// When org mode is enabled, it fans out scanning across all accounts in an
// AWS Organization using per-account AssumeRole credentials.
package aws

import (
	"context"
	"fmt"
	"sync"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	"github.com/aws/aws-sdk-go-v2/service/sso"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/checkpoint"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/cloudutil"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// Scanner implements scanner.Scanner for AWS.
type Scanner struct{}

// New returns a ready-to-use AWS Scanner.
func New() *Scanner { return &Scanner{} }

// maxConcurrentAccounts is the default concurrency for org mode account fan-out.
const maxConcurrentAccounts = 5

// Scan satisfies scanner.Scanner. It:
//  1. Builds an aws.Config from req.Credentials (auth_method routing)
//  2. In single-account mode: scans the authenticated account directly
//  3. In org mode: discovers all org accounts, fans out per-account with AssumeRole
//  4. Returns all FindingRows and any per-provider error
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

	// Org mode: fan out per-account.
	if creds["org_enabled"] == "true" {
		return s.scanOrg(ctx, baseCfg, creds, req.MaxWorkers, req.CheckpointPath, publish)
	}

	// Single-account mode (existing behavior).
	accountID, err := getAccountID(ctx, baseCfg)
	if err != nil {
		return nil, fmt.Errorf("aws: get account id: %w", err)
	}
	accountName := getAccountName(ctx, baseCfg, accountID)
	return scanOneAccount(ctx, baseCfg, accountName, req.MaxWorkers, publish)
}

// discoverAccountsFunc is the function used by scanOrg to discover org accounts.
// It defaults to DiscoverAccounts and can be swapped in tests.
var discoverAccountsFunc = DiscoverAccounts

// getAccountIDFunc is the function used by scanOrg to get the management account ID.
// It defaults to getAccountID and can be swapped in tests.
var getAccountIDFunc = getAccountID

// scanOneAccountFunc is the function used by scanOrg to scan a single account.
// It defaults to scanOneAccount and can be swapped in tests to inject failures
// or stub results.
var scanOneAccountFunc = scanOneAccount

// scanOneAccount runs the full scan for a single AWS account:
// Route53 globally + all enabled regions in parallel.
func scanOneAccount(ctx context.Context, cfg awssdk.Config, accountName string, maxWorkers int, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	var findings []calculator.FindingRow

	// Route53 is a global service — scan once with the bootstrap region config.
	r53Findings := scanRoute53(ctx, cfg, accountName, publish)
	findings = append(findings, r53Findings...)

	// Enumerate enabled regions and scan each in parallel (with semaphore).
	regions, err := listEnabledRegions(ctx, cfg)
	if err != nil {
		return findings, fmt.Errorf("aws: list regions: %w", err)
	}

	regionalFindings := scanAllRegions(ctx, cfg, regions, accountName, maxWorkers, publish)
	findings = append(findings, regionalFindings...)

	return findings, nil
}

// scanOrg implements the Organizations multi-account fan-out.
// It discovers all org accounts, identifies the management account, then scans
// each account concurrently: management uses base credentials, child accounts
// use AssumeRole. Per-account failures are non-fatal.
// When checkpointPath is non-empty and there are multiple accounts, completed
// accounts are loaded from a prior checkpoint and skipped on resume.
func (s *Scanner) scanOrg(ctx context.Context, baseCfg awssdk.Config, creds map[string]string, maxWorkers int, checkpointPath string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	orgRoleName := creds["org_role_name"]
	if orgRoleName == "" {
		orgRoleName = "OrganizationAccountAccessRole"
	}

	// Discover management account ID.
	mgmtAccountID, err := getAccountIDFunc(ctx, baseCfg)
	if err != nil {
		return nil, fmt.Errorf("aws org: get management account id: %w", err)
	}

	// Discover all org accounts.
	accounts, err := discoverAccountsFunc(ctx, baseCfg)
	if err != nil {
		return nil, fmt.Errorf("aws org: discover accounts: %w", err)
	}

	publish(scanner.Event{
		Type:     "account_progress",
		Provider: scanner.ProviderAWS,
		Status:   "scanning",
		Message:  fmt.Sprintf("discovered %d accounts in organization", len(accounts)),
	})

	// ── Checkpoint: load prior state ──
	var cp *checkpoint.Checkpoint
	completed := make(map[string]bool)
	var findings []calculator.FindingRow

	if checkpointPath != "" && len(accounts) > 1 {
		if state, loadErr := checkpoint.Load(checkpointPath); loadErr != nil {
			publish(scanner.Event{
				Type:     "checkpoint_error",
				Provider: scanner.ProviderAWS,
				Message:  fmt.Sprintf("failed to load checkpoint, starting fresh: %v", loadErr),
			})
		} else if state != nil {
			for _, u := range state.CompletedUnits {
				completed[u.ID] = true
				findings = append(findings, u.Findings...)
			}
			publish(scanner.Event{
				Type:     "checkpoint_loaded",
				Provider: scanner.ProviderAWS,
				Message:  fmt.Sprintf("resuming from checkpoint: %d accounts already complete", len(state.CompletedUnits)),
			})
		}
		cp = checkpoint.New(checkpointPath, "", scanner.ProviderAWS)
	}

	// Fan out per-account with semaphore.
	accountWorkers := maxConcurrentAccounts
	if maxWorkers > 0 {
		accountWorkers = maxWorkers
	}
	sem := cloudutil.NewSemaphore(accountWorkers)

	var (
		mu sync.Mutex
		wg sync.WaitGroup
	)

	for _, acct := range accounts {
		acct := acct // capture
		wg.Add(1)
		go func() {
			defer wg.Done()

			if err := sem.Acquire(ctx); err != nil {
				return
			}
			defer sem.Release()

			accountName := acct.Name
			if accountName == "" {
				accountName = "Account " + acct.ID
			}

			// ── Checkpoint: skip completed accounts ──
			if completed[acct.ID] {
				publish(scanner.Event{
					Type:     "account_progress",
					Provider: scanner.ProviderAWS,
					Status:   "skipped",
					Message:  fmt.Sprintf("skipping already-completed account %s (%s)", accountName, acct.ID),
				})
				return
			}

			publish(scanner.Event{
				Type:     "account_progress",
				Provider: scanner.ProviderAWS,
				Status:   "scanning",
				Message:  fmt.Sprintf("scanning account %s (%s)", accountName, acct.ID),
			})

			var accountCfg awssdk.Config
			var cfgErr error

			if acct.ID == mgmtAccountID {
				// Management account uses base credentials directly — no self-assume.
				accountCfg = baseCfg
			} else {
				// Child account: AssumeRole into the org role.
				accountCfg, cfgErr = buildOrgAccountConfig(baseCfg, acct.ID, orgRoleName)
				if cfgErr != nil {
					// Non-fatal: publish warning and continue.
					publish(scanner.Event{
						Type:     "account_progress",
						Provider: scanner.ProviderAWS,
						Status:   "error",
						Message:  fmt.Sprintf("AssumeRole failed for account %s (%s): %v", accountName, acct.ID, cfgErr),
					})
					return
				}
			}

			rows, scanErr := scanOneAccountFunc(ctx, accountCfg, accountName, 0, publish)

			mu.Lock()
			findings = append(findings, rows...)
			mu.Unlock()

			if scanErr != nil {
				publish(scanner.Event{
					Type:     "account_progress",
					Provider: scanner.ProviderAWS,
					Status:   "error",
					Message:  fmt.Sprintf("scan failed for account %s (%s): %v", accountName, acct.ID, scanErr),
				})
			} else {
				publish(scanner.Event{
					Type:     "account_progress",
					Provider: scanner.ProviderAWS,
					Status:   "complete",
					Message:  fmt.Sprintf("completed account %s (%s): %d findings", accountName, acct.ID, len(rows)),
				})

				// ── Checkpoint: save after each successful account ──
				if cp != nil {
					if saveErr := cp.AddUnit(checkpoint.CompletedUnit{
						ID:          acct.ID,
						Name:        accountName,
						CompletedAt: time.Now(),
						Findings:    rows,
					}); saveErr != nil {
						publish(scanner.Event{
							Type:     "checkpoint_error",
							Provider: scanner.ProviderAWS,
							Message:  fmt.Sprintf("failed to save checkpoint: %v", saveErr),
						})
					} else {
						publish(scanner.Event{
							Type:     "checkpoint_saved",
							Provider: scanner.ProviderAWS,
							Message:  checkpointPath,
						})
					}
				}
			}
		}()
	}

	wg.Wait()

	// ── Checkpoint: clean up on full success ──
	if cp != nil && checkpointPath != "" {
		_ = checkpoint.Delete(checkpointPath)
	}

	return findings, nil
}

// buildOrgAccountConfig creates an aws.Config for a child account by assuming the
// specified role via STS. The config uses CredentialsCache for auto-refresh.
func buildOrgAccountConfig(baseCfg awssdk.Config, accountID, roleName string) (awssdk.Config, error) {
	roleARN := fmt.Sprintf("arn:aws:iam::%s:role/%s", accountID, roleName)
	stsClient := sts.NewFromConfig(baseCfg)
	provider := stscreds.NewAssumeRoleProvider(stsClient, roleARN, func(o *stscreds.AssumeRoleOptions) {
		o.RoleSessionName = "uddi-org-scan"
	})

	cfg := baseCfg.Copy()
	cfg.Credentials = awssdk.NewCredentialsCache(provider)
	return cfg, nil
}

// buildConfig constructs an aws.Config from the credential map.
// auth_method values: "access_key" | "access-key" | "profile" | "sso" | "assume_role" | "assume-role" | "org"
// Hyphenated variants ("access-key", "assume-role") are accepted as aliases for the
// underscore forms so that the frontend's kebab-case auth method IDs work without
// a mapping step. "org" uses access_key credentials as its base auth.
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
	case "access_key", "access-key", "", "org":
		// "org" uses access_key credentials as the base — the org fan-out is handled
		// at the Scan() level, not in buildConfig.
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
		// Base credentials come from sourceProfile (not access key fields).
		// Per user decision: matches AWS CLI source_profile convention.
		sourceProfile := creds["source_profile"]
		if sourceProfile == "" {
			sourceProfile = "default"
		}
		baseCfg, err := awsconfig.LoadDefaultConfig(ctx,
			append(retryOpts, awsconfig.WithSharedConfigProfile(sourceProfile))...,
		)
		if err != nil {
			return awssdk.Config{}, fmt.Errorf("assume_role source profile %q: %w", sourceProfile, err)
		}
		stsClient := sts.NewFromConfig(baseCfg)
		provider := stscreds.NewAssumeRoleProvider(stsClient, creds["role_arn"], func(o *stscreds.AssumeRoleOptions) {
			o.RoleSessionName = "uddi-go-token-calculator"
			if eid := creds["external_id"]; eid != "" {
				o.ExternalID = &eid
			}
		})
		// CredentialsCache auto-refreshes 5 minutes before expiry -- survives long multi-region scans.
		baseCfg.Credentials = awssdk.NewCredentialsCache(provider)
		return baseCfg, nil

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
