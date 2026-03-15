# Phase 15: Quick-Win Auth Methods - Research

**Researched:** 2026-03-14
**Domain:** AWS/Azure/AD authentication methods -- backend validator + scanner wiring
**Confidence:** HIGH

## Summary

Phase 15 implements four authentication methods that currently return "Coming soon" or silently ignore settings: AWS CLI Profile, AWS Assume Role, Azure CLI, and AD WinRM over HTTPS. All four require **zero new Go dependencies** -- every needed package is already in `go.mod` or is a subpackage of an existing dependency. The work is entirely backend: the frontend already has all form fields and auth method IDs defined in `mock-data.ts`.

The implementation pattern is consistent across all four: (1) add a `case` to the validator's `switch creds["authMethod"]` in `server/validate.go`, (2) ensure the session stores the right fields, (3) ensure the orchestrator maps those fields correctly into the scanner's `ScanRequest.Credentials` map, and (4) ensure the scanner's `buildConfig`/`BuildNTLMClient` handles the new auth method. For AWS Profile and Azure CLI, the scanner side already works or needs minimal changes. For AWS Assume Role, the scanner needs a refactor from static one-time STS credentials to `stscreds.AssumeRoleProvider` with `aws.CredentialsCache`. For AD HTTPS, `BuildNTLMClient` needs new parameters for port/TLS/insecure-skip.

**Primary recommendation:** Implement all four in a single wave since they are independent, backend-only changes with well-defined integration points.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- AWS CLI Profile: Validator calls STS GetCallerIdentity with named profile via `LoadDefaultConfig` + `WithSharedConfigProfile`. SSO profiles handled transparently. Scanner `buildConfig` already handles profile case.
- AWS Assume Role: Base credentials come from `sourceProfile` field (not access key fields). Default sourceProfile to "default" if empty. Use `stscreds.AssumeRoleProvider` wrapped in `aws.CredentialsCache` for auto-refreshing credentials. Validator returns assumed account ID (target, not source).
- Azure CLI: Pre-check `az` binary via `exec.LookPath("az")` before `azidentity.NewAzureCLICredential`. Clear error with install link if missing. Actionable error if session expired. Cache credential in `azureCredCache` using same pattern as browser SSO.
- AD WinRM HTTPS: `BuildNTLMClient` gains HTTPS support -- port 5986 with TLS when `useSSL=true`. Add "Allow untrusted certificates" toggle. Use basic NTLM auth (ClientNTLM) over TLS -- no SPNEGO message-level encryption needed (TLS provides transport security). Validator probe uses same transport.
- `powershell-remote` authMethod maps to NTLM backend with a transport flag -- not a separate auth method dispatch case.

### Claude's Discretion
- AWS Profile: Authenticate-only vs list profiles (recommend authenticate-only). Error formatting for missing credentials file. Whether empty profile defaults to "default".
- AWS Assume Role: ExternalId handling (only send when non-empty). Session duration. Error formatting for role assumption failures.

### Deferred Ideas (OUT OF SCOPE)
None.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| AWS-AUTH-01 | User can authenticate with AWS CLI Profile by selecting named profile | Validator case in `realAWSValidator`, `LoadDefaultConfig` with `WithSharedConfigProfile`, scanner `buildConfig` already handles `profile` case |
| AWS-AUTH-02 | User can authenticate via AWS Assume Role with auto-refreshing credentials | `stscreds.AssumeRoleProvider` + `aws.CredentialsCache` in scanner, sourceProfile-based base credentials, validator returns target account ID |
| AZ-AUTH-02 | User can authenticate via Azure CLI session with clear `az` missing error | `exec.LookPath("az")` pre-check, `azidentity.NewAzureCLICredential`, credential cache in `azureCredCache`, subscription listing |
| AD-AUTH-02 | User can connect via WinRM over HTTPS with TLS certificate validation toggle | `BuildNTLMClient` parameter extension (useHTTPS, insecureSkipVerify), `winrm.NewEndpoint` args, session field additions |
</phase_requirements>

## Standard Stack

### Core (already in go.mod)
| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| `aws-sdk-go-v2/config` | v1.32.11 | `LoadDefaultConfig` + `WithSharedConfigProfile` for CLI profiles | Already imported |
| `aws-sdk-go-v2/credentials/stscreds` | v1.19.11 (subpackage) | `AssumeRoleProvider` for auto-refreshing role credentials | Available, not yet imported |
| `aws-sdk-go-v2/service/sts` | v1.41.8 | `GetCallerIdentity` for validation | Already imported |
| `azidentity` | v1.13.1 | `NewAzureCLICredential` for `az login` sessions | Already imported |
| `masterzen/winrm` | (in go.mod) | `NewEndpoint` with HTTPS params for TLS transport | Already imported |
| `os/exec` | stdlib | `exec.LookPath("az")` for binary existence check | No import needed |

### No New Dependencies
All four auth methods use packages already in `go.mod` or the standard library. `stscreds` is a subpackage of the already-imported `aws-sdk-go-v2/credentials` module -- `go get` is not needed but the import path must be added.

## Architecture Patterns

### Validator Dispatch Pattern (established)
```
realAWSValidator(ctx, creds) -> switch creds["authMethod"]:
  "sso"          -> realAWSSSO()        // existing
  "profile"      -> NEW: profile logic
  "assume-role"  -> NEW: assume-role logic
  default        -> existing access-key logic
```

### Credential Flow: Validate -> Session -> Orchestrator -> Scanner
```
1. Frontend POST /validate with authMethod + credentials
2. Validator authenticates, returns SubscriptionItems
3. storeCredentials() saves to session struct
4. Orchestrator maps session fields to ScanRequest.Credentials map
5. Scanner reads from Credentials map in buildConfig/BuildNTLMClient
```

**Key field name translations** (validate vs scanner):
| Validate (camelCase) | Session Field | Orchestrator (snake_case) | Scanner reads |
|---------------------|---------------|--------------------------|---------------|
| `profile` | `ProfileName` | `profile_name` | `profile_name` |
| `roleArn` | `RoleARN` | `role_arn` | `role_arn` |
| `sourceProfile` | NEW field needed | NEW mapping | `source_profile` |
| `externalId` | NEW field needed | NEW mapping | `external_id` |
| `useSSL` | NEW field needed | NEW mapping | `use_ssl` |
| `insecureSkipVerify` | NEW field needed | NEW mapping | `insecure_skip_verify` |

### AWS CLI Profile Implementation
```go
// In validate.go - realAWSValidator, add case:
case "profile":
    profileName := creds["profile"]
    if profileName == "" {
        profileName = "default"
    }
    cfg, err := awsconfig.LoadDefaultConfig(ctx,
        awsconfig.WithSharedConfigProfile(profileName),
    )
    // ... STS GetCallerIdentity with cfg
```

Scanner side (`buildConfig` case "profile") already works -- it reads `profile_name` from credentials map and calls `awsconfig.WithSharedConfigProfile`. No scanner changes needed.

### AWS Assume Role Implementation
```go
// In validate.go - realAWSValidator, add case:
case "assume_role", "assume-role":
    sourceProfile := creds["sourceProfile"]
    if sourceProfile == "" {
        sourceProfile = "default"
    }
    roleArn := creds["roleArn"]
    // Load base config from source profile
    baseCfg, err := awsconfig.LoadDefaultConfig(ctx,
        awsconfig.WithSharedConfigProfile(sourceProfile),
    )
    // AssumeRole for validation (one-time is fine for validate)
    stsClient := sts.NewFromConfig(baseCfg)
    input := &sts.AssumeRoleInput{
        RoleArn:         aws.String(roleArn),
        RoleSessionName: aws.String("uddi-validate"),
    }
    if eid := creds["externalId"]; eid != "" {
        input.ExternalId = aws.String(eid)
    }
    result, err := stsClient.AssumeRole(ctx, input)
    // Return target account ID from assumed identity
```

Scanner side needs refactoring -- currently uses static one-time STS credentials. Must change to:
```go
// In scanner/aws/scanner.go buildConfig, case "assume_role":
case "assume_role", "assume-role":
    sourceProfile := creds["source_profile"]
    if sourceProfile == "" {
        sourceProfile = "default"
    }
    baseCfg, err := awsconfig.LoadDefaultConfig(ctx,
        append(retryOpts, awsconfig.WithSharedConfigProfile(sourceProfile))...,
    )
    stsClient := sts.NewFromConfig(baseCfg)
    assumeOpts := func(o *stscreds.AssumeRoleOptions) {
        if eid := creds["external_id"]; eid != "" {
            o.ExternalID = &eid
        }
    }
    provider := stscreds.NewAssumeRoleProvider(stsClient, creds["role_arn"], assumeOpts)
    baseCfg.Credentials = aws.NewCredentialsCache(provider)
    return baseCfg, nil
```

### Azure CLI Implementation
```go
// In validate.go - realAzureValidator, add case:
case "az-cli":
    // Pre-check az binary
    if _, err := exec.LookPath("az"); err != nil {
        return nil, errors.New("Azure CLI (az) not found. Install from https://aka.ms/installazurecli")
    }
    cred, err := azidentity.NewAzureCLICredential(nil)
    if err != nil {
        return nil, fmt.Errorf("Azure CLI credential failed — run 'az login' first: %w", err)
    }
    // Cache credential
    cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
    azureCredCacheMu.Lock()
    azureCredCache[cacheKey] = cred
    azureCredCacheMu.Unlock()
    creds["azure_cred_cache_key"] = cacheKey
    // List subscriptions (reuse existing pattern from realAzureBrowserSSO)
```

Scanner side: `buildCredential` in `internal/scanner/azure/scanner.go` needs a new `case "az-cli"` that returns the cached credential (same pattern as `browser-sso`).

### AD HTTPS Implementation
```go
// BuildNTLMClient gains parameters:
func BuildNTLMClient(host, username, password string, opts ...ClientOption) (*winrm.Client, error) {
    o := defaultOptions() // port=5985, useHTTPS=false, insecureSkipVerify=false
    for _, opt := range opts {
        opt(&o)
    }
    endpoint := winrm.NewEndpoint(host, o.port, o.useHTTPS, o.insecureSkipVerify, nil, nil, nil, winrmTimeout)
    // When HTTPS is enabled, use ClientNTLM (no SPNEGO encryption needed -- TLS provides it)
    if o.useHTTPS {
        params := *winrm.DefaultParameters
        // ClientNTLM for NTLM auth without message-level encryption
        return winrm.NewClientWithParameters(endpoint, username, password, &params)
    }
    // Existing SPNEGO encryption path for plain HTTP
    params := *winrm.DefaultParameters
    enc, err := winrm.NewEncryption("ntlm")
    ...
}
```

**Critical insight for HTTPS path:** When WinRM uses HTTPS (port 5986), the TLS layer provides transport encryption. SPNEGO message-level encryption (`winrm.NewEncryption("ntlm")`) is NOT needed and may actually conflict. Use basic `ClientNTLM` transport decorator (or no decorator) over TLS. The `winrm.NewEndpoint` third parameter (`useHTTPS=true`) tells the library to use `https://` scheme and the fourth parameter (`insecure=true`) skips TLS certificate validation.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| AWS credential auto-refresh | Manual STS refresh timer | `stscreds.AssumeRoleProvider` + `aws.CredentialsCache` | SDK handles refresh 5min before expiry, thread-safe, tested |
| Azure CLI token management | Parse `~/.azure/` token cache | `azidentity.NewAzureCLICredential` | SDK shells out to `az account get-access-token`, handles refresh |
| WinRM TLS setup | Custom TLS dialer | `winrm.NewEndpoint(..., useHTTPS=true, insecure, ...)` | Library handles scheme, port, TLS config internally |
| AWS profile resolution | Parse `~/.aws/config` manually | `awsconfig.WithSharedConfigProfile` | SDK handles SSO profiles, credential process, MFA, etc. |

## Common Pitfalls

### Pitfall 1: AWS Assume Role with Static Credentials Expires Mid-Scan
**What goes wrong:** Current scanner code calls `sts.AssumeRole` once and uses the returned temporary credentials as static credentials. These expire after 1 hour (default). Multi-region scans of large AWS accounts can exceed 1 hour.
**Why it happens:** `credentials.NewStaticCredentialsProvider` does not auto-refresh.
**How to avoid:** Use `stscreds.AssumeRoleProvider` wrapped in `aws.CredentialsCache`. The cache automatically refreshes credentials 5 minutes before expiry.
**Warning signs:** Scans fail with `ExpiredTokenException` after ~55 minutes.

### Pitfall 2: AWS Assume Role with ExternalId
**What goes wrong:** Passing an empty `ExternalId` string to STS `AssumeRole` causes an `InvalidParameterValue` error. AWS rejects empty-string ExternalId (it must be nil or a non-empty string).
**How to avoid:** Only set `ExternalId` in the `AssumeRoleInput` when the value is non-empty.

### Pitfall 3: Azure CLI Credential Error Messages
**What goes wrong:** `azidentity.NewAzureCLICredential` fails with a cryptic Go error when `az` is not installed. Users see a Go stack trace instead of an actionable message.
**How to avoid:** Pre-check with `exec.LookPath("az")` and return a user-friendly error with install URL before attempting credential creation.

### Pitfall 4: WinRM HTTPS + SPNEGO Encryption Conflict
**What goes wrong:** Using `winrm.NewEncryption("ntlm")` (SPNEGO message-level encryption) over an HTTPS connection can cause double-encryption or protocol errors on some Windows Server versions.
**Why it happens:** SPNEGO encryption wraps the HTTP body in multipart/encrypted framing. Over TLS this is redundant and some servers reject it.
**How to avoid:** When `useHTTPS=true`, skip the SPNEGO encryption decorator entirely. Use plain `ClientNTLM` or no transport decorator -- TLS already provides confidentiality.

### Pitfall 5: Source Profile for Assume Role -- Key Name Mismatch
**What goes wrong:** The frontend sends `sourceProfile` (camelCase), the session stores it, the orchestrator must map it to `source_profile` (snake_case) for the scanner. Missing this mapping means the scanner falls back to access-key auth and fails.
**How to avoid:** Add `SourceProfile` and `ExternalID` fields to `session.AWSCredentials`. Add orchestrator mapping lines.

### Pitfall 6: AD HTTPS Self-Signed Certificates
**What goes wrong:** Most enterprise WinRM HTTPS endpoints use self-signed certificates. Without `insecureSkipVerify=true`, TLS handshake fails with `x509: certificate signed by unknown authority`.
**How to avoid:** The frontend already has a `useSSL` field. Need to add `insecureSkipVerify` as a separate field (or toggle "Allow untrusted certificates") in `mock-data.ts` for the powershell-remote auth method.

## Code Examples

### stscreds.AssumeRoleProvider Usage
```go
// Source: aws-sdk-go-v2/credentials/stscreds@v1.19.11/assume_role_provider.go
import "github.com/aws/aws-sdk-go-v2/credentials/stscreds"

provider := stscreds.NewAssumeRoleProvider(stsClient, roleArn, func(o *stscreds.AssumeRoleOptions) {
    o.RoleSessionName = "uddi-go-token-calculator"
    if externalID != "" {
        o.ExternalID = &externalID
    }
})
cfg.Credentials = aws.NewCredentialsCache(provider)
```

### azidentity.NewAzureCLICredential Usage
```go
// Source: azidentity@v1.13.1/azure_cli_credential.go
cred, err := azidentity.NewAzureCLICredential(nil) // nil options = default tenant
// To force a specific tenant:
cred, err := azidentity.NewAzureCLICredential(&azidentity.AzureCLICredentialOptions{
    TenantID: "specific-tenant-id",
})
```

### winrm.NewEndpoint HTTPS Parameters
```go
// Source: masterzen/winrm endpoint.go
// Signature: NewEndpoint(host string, port int, useHTTPS bool, insecure bool, caCert []byte, cert []byte, key []byte, timeout time.Duration)
endpoint := winrm.NewEndpoint(host, 5986, true, true, nil, nil, nil, winrmTimeout)
// useHTTPS=true -> https:// scheme
// insecure=true -> skip TLS cert verification (self-signed certs)
```

## State of the Art

| Old Approach (current code) | Current Approach (this phase) | Impact |
|---------------------------|-------------------------------|--------|
| Static STS credentials for assume-role | `stscreds.AssumeRoleProvider` + `CredentialsCache` | Auto-refresh eliminates timeout during long scans |
| "Coming soon" for profile/assume-role | Full `LoadDefaultConfig` + `WithSharedConfigProfile` | SSO profiles work transparently |
| No Azure CLI support | `azidentity.NewAzureCLICredential` with LookPath pre-check | Zero-field auth for users with existing `az login` |
| WinRM HTTP only (port 5985) | Conditional HTTPS (port 5986) with TLS | Supports hardened AD environments |

## Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `server/validate.go` | Add profile/assume-role/az-cli cases | 3 new case blocks (~80 lines) |
| `internal/scanner/aws/scanner.go` | Refactor assume-role to use `stscreds.AssumeRoleProvider` + source profile | ~30 lines changed |
| `internal/scanner/azure/scanner.go` | Add az-cli case to `buildCredential` | ~10 lines |
| `internal/scanner/ad/scanner.go` | Add HTTPS params to `BuildNTLMClient` | ~30 lines (add options pattern) |
| `internal/session/session.go` | Add SourceProfile, ExternalID, UseSSL, InsecureSkipVerify fields | ~8 lines |
| `internal/orchestrator/orchestrator.go` | Map new session fields to ScanRequest | ~8 lines |
| `frontend/src/app/components/mock-data.ts` | Add insecureSkipVerify field to powershell-remote | ~1 line |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Go testing + httptest (stdlib) |
| Config file | none (Go convention) |
| Quick run command | `go test ./server/ ./internal/scanner/aws/ ./internal/scanner/ad/ ./internal/scanner/azure/ -count=1 -run TestValidate` |
| Full suite command | `go test ./... -count=1` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AWS-AUTH-01 | Profile validator calls STS with named profile | unit | `go test ./server/ -run TestValidateAWSProfile -count=1` | Wave 0 |
| AWS-AUTH-02 | Assume-role validator returns target account ID | unit | `go test ./server/ -run TestValidateAWSAssumeRole -count=1` | Wave 0 |
| AWS-AUTH-02 | Scanner buildConfig uses AssumeRoleProvider | unit | `go test ./internal/scanner/aws/ -run TestBuildConfigAssumeRole -count=1` | Wave 0 |
| AZ-AUTH-02 | Azure CLI validator pre-checks az binary | unit | `go test ./server/ -run TestValidateAzureCLI -count=1` | Wave 0 |
| AD-AUTH-02 | BuildNTLMClient produces HTTPS endpoint | unit | `go test ./internal/scanner/ad/ -run TestBuildNTLMClientHTTPS -count=1` | Wave 0 |

### Sampling Rate
- **Per task commit:** `go test ./server/ ./internal/scanner/aws/ ./internal/scanner/ad/ ./internal/scanner/azure/ -count=1 -v`
- **Per wave merge:** `go test ./... -count=1`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `server/validate_test.go` -- add test cases for profile, assume-role, az-cli auth methods (stub validators exist; need cases that verify dispatch + error messages)
- [ ] `internal/scanner/ad/scanner_test.go` -- add test for BuildNTLMClient HTTPS parameter handling
- [ ] `internal/scanner/aws/scanner_test.go` -- add test for buildConfig assume-role with stscreds (may need mock STS)

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `server/validate.go`, `internal/scanner/aws/scanner.go`, `internal/scanner/ad/scanner.go`, `internal/scanner/azure/scanner.go`, `internal/session/session.go`, `internal/orchestrator/orchestrator.go`
- `aws-sdk-go-v2/credentials/stscreds@v1.19.11` -- `AssumeRoleProvider` verified locally in module cache
- `azidentity@v1.13.1` -- `AzureCLICredential` verified locally in module cache
- `masterzen/winrm` -- `NewEndpoint` signature verified in code (host, port, useHTTPS, insecure, caCert, cert, key, timeout)
- `frontend/src/app/components/mock-data.ts` -- verified all four auth method form definitions exist

### Secondary (MEDIUM confidence)
- `winrm.NewEndpoint` HTTPS + NTLM interaction (SPNEGO encryption conflict over TLS) -- based on masterzen/winrm library behavior and WinRM protocol knowledge

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all packages verified in go.mod/module cache
- Architecture: HIGH -- established patterns in codebase, all integration points inspected
- Pitfalls: HIGH -- derived from actual code inspection (static creds, field name mismatches, endpoint params)

**Research date:** 2026-03-14
**Valid until:** 2026-04-14 (stable -- no fast-moving dependencies)