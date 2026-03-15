# Project Research Summary

**Project:** UDDI-GO Token Calculator — Auth Method Completion (v2.1)
**Domain:** Authentication method integration for Go+React cloud infrastructure scanner
**Researched:** 2026-03-14
**Confidence:** HIGH

## Executive Summary

This research covers completing 9 authentication methods across AWS, Azure, GCP, and AD providers in the UDDI-GO Token Calculator. The single most important finding is that **zero new Go dependencies are required** -- every auth method can be implemented using libraries already in `go.mod`. This eliminates risk of CGO contamination, binary size increase, and new supply-chain surface. The existing codebase already has the dispatch architecture (switch on `authMethod` in both validators and scanners), so each new auth method slots into existing switch statements across 4 layers: frontend, validator, session, and scanner.

The recommended approach is a 3-phase rollout ordered by complexity and risk. Phase 1 covers 4 methods that are already partially implemented in the scanner but return "Coming soon" from the validator -- these are effectively wiring fixes requiring under 50 lines each. Phase 2 covers 3 methods with medium complexity that follow established patterns (cached credentials, browser-open-then-poll). Phase 3 covers 2 methods with high implementation risk (GCP Browser OAuth requires a custom OAuth2 flow with no SDK helper; AD Kerberos has fundamental CGO_ENABLED=0 limitations for Windows integrated auth).

The primary risks are: (1) Azure PFX certificate parsing fails on modern SHA256-MAC files exported from Azure Portal -- requires a fallback parser; (2) AWS AssumeRole uses static credentials that expire during long scans -- must switch to `AssumeRoleProvider` with auto-refresh; (3) AD Kerberos cannot do true Windows integrated auth (no password) without CGO/SSPI -- the frontend description is misleading and must be updated. Total estimated effort across all 9 methods is approximately 380 lines of Go and 1 frontend text update.

## Key Findings

### Recommended Stack

No stack changes. All 9 auth methods use existing `go.mod` dependencies. The key libraries are `azidentity` (v1.13.1) for 3 Azure methods, `aws-sdk-go-v2/config` + `sts` for 2 AWS methods, `golang.org/x/oauth2/google` for 2 GCP methods, and `masterzen/winrm` + `jcmturner/gokrb5/v8` for 2 AD methods. All are pure Go, CGO_ENABLED=0 compatible.

**Core technologies (all existing):**
- `azidentity` — Azure auth (ClientCertificateCredential, AzureCLICredential, DeviceCodeCredential)
- `aws-sdk-go-v2/config` + `stscreds` — AWS auth (SharedConfigProfile, AssumeRoleProvider)
- `golang.org/x/oauth2/google` — GCP auth (CredentialsFromJSONWithParams for WIF, OAuth2 localhost flow)
- `masterzen/winrm` + `jcmturner/gokrb5/v8` — AD auth (ClientKerberos transport, HTTPS endpoint)

**One potential addition:** `software.sslmate.com/src/go-pkcs12` as fallback for SHA256-MAC PFX files that `azidentity.ParseCertificates()` cannot handle. Pure Go, no CGO.

### Expected Features

**Must have (table stakes) -- users see these in the dropdown and expect them to work:**
- AWS CLI Profile -- backend done, validator returns "Coming soon" (~20 LOC fix)
- AWS Assume Role -- backend done, validator returns "Coming soon" (~40 LOC fix)
- Azure CLI (`az login`) -- zero-field auth, one-liner credential (~30 LOC)
- AD PowerShell Remoting HTTPS -- `useSSL` flag currently ignored (~50 LOC)

**Should have (differentiators):**
- Azure Certificate SP -- PEM/PFX cert auth for production service principals
- Azure Device Code -- headless/remote scenarios (SSH sessions, VMs)
- AD Kerberos -- clear error messaging + NTLM fallback (not true integrated auth)

**Defer (v2.2+):**
- GCP Browser OAuth -- no SDK helper exists; requires custom OAuth2 flow, uncertain Cloud SDK client ID reuse
- GCP Workload Identity Federation -- only works inside federated cloud environments, niche for a customer-facing .exe
- AD Kerberos SSPI integration -- requires CGO, breaks cross-compile pipeline

### Architecture Approach

The auth flow is a clean 4-layer pipeline: Frontend (mock-data.ts defines auth methods) -> Validate Handler (dispatches per-provider, caches credentials) -> Session (typed credential structs) -> Scanner (buildConfig/buildCredential dispatches on auth_method). Each new method adds a case to existing switch statements in the validator and scanner. No new components, endpoints, or architectural patterns are needed except for Azure Device Code (which follows the existing AWS SSO browser-open-then-poll pattern).

**Key patterns to follow:**
1. **Cached Credential Object** -- validator creates a live credential, caches in process-level map, scanner retrieves via ScanRequest side-channel (existing pattern for Azure browser-SSO and GCP ADC)
2. **Browser-Open-Then-Poll** -- validator opens browser, blocks up to 120s while polling for completion (existing pattern for AWS SSO)
3. **Auth-Method Switch Dispatch** -- `switch creds["authMethod"]` in validator, `switch creds["auth_method"]` in scanner (note: camelCase vs snake_case)

**Anti-patterns to avoid:**
- Silent fallthrough to a different auth method when the selected one is unrecognized
- Reading files during scan (read during validation, cache in session)
- Adding new ScanRequest side-channel fields (reuse existing `CachedAzureCredential` / `CachedGCPTokenSource` interfaces)

### Critical Pitfalls

1. **Azure PFX SHA256 MAC failure** -- `azidentity.ParseCertificates()` cannot parse modern PFX files. Fall back to `sslmate/go-pkcs12`. Test with Azure Portal-exported PFX, not just PEM.
2. **AWS AssumeRole token expiry** -- current code uses static credentials from a one-time `sts.AssumeRole` call. Switch to `stscreds.NewAssumeRoleProvider` with `aws.NewCredentialsCache()` for auto-refresh.
3. **Validate-then-scan credential gap** -- short-lived tokens obtained during validation expire before scan starts. Cache refreshable credential objects, not static tokens.
4. **AD Kerberos cannot do Windows integrated auth** -- pure Go `gokrb5` cannot access Windows LSASS credential cache. "Use your current Windows domain session" UI description is misleading. Must accept username/password or fall back to NTLM with clear messaging.
5. **Azure CLI not available on customer machines** -- `az` CLI dependency contradicts the "single .exe, no dependencies" distribution model. Add `exec.LookPath("az")` pre-check with clear error message.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Quick Wins (4 methods)
**Rationale:** These are either already implemented in the scanner (just missing validator wiring) or trivially simple. Clears all "Coming soon" messages and silent fallthroughs. Maximum user impact for minimum effort.
**Delivers:** AWS CLI Profile, AWS Assume Role, Azure CLI, AD PowerShell HTTPS
**Addresses:** All table-stakes features
**Avoids:** Silent fallthrough anti-pattern (Pitfall: unrecognized auth methods)
**Estimated effort:** ~140 LOC Go, no frontend changes
**Key pitfall to address:** AWS AssumeRole must use `AssumeRoleProvider` with `CredentialsCache`, not static credentials. Azure CLI needs `exec.LookPath("az")` pre-check.

### Phase 2: Medium Complexity (3 methods)
**Rationale:** These follow established codebase patterns (cached credentials, browser-open-then-poll) but need more careful error handling and one new session field each.
**Delivers:** Azure Certificate SP, Azure Device Code, AD Kerberos (with NTLM fallback)
**Uses:** `azidentity.NewClientCertificateCredential`, `azidentity.NewDeviceCodeCredential`, `winrm.ClientKerberos`
**Avoids:** PFX SHA256 failure (add `sslmate/go-pkcs12` fallback), Kerberos SSPI impossibility (clear messaging + fallback)
**Estimated effort:** ~170 LOC Go, update Kerberos frontend description
**Key pitfall to address:** Azure Device Code must surface the user code + URL to the frontend. Follow AWS SSO pattern: open browser, block in handler, poll until completion.

### Phase 3: GCP Advanced Auth (2 methods)
**Rationale:** Highest implementation risk and lowest priority. GCP Browser OAuth has no SDK equivalent to Azure's `InteractiveBrowserCredential`. Workload Identity only works inside federated environments (not the typical customer laptop scenario).
**Delivers:** GCP Browser OAuth, GCP Workload Identity Federation
**Uses:** `golang.org/x/oauth2` manual authorization code flow, `google.CredentialsFromJSONWithParams` with external_account JSON
**Avoids:** OAuth redirect port collision (use fixed unusual port or switch to device code flow), token refresh failure (set `access_type=offline`)
**Estimated effort:** ~230 LOC Go
**Key pitfall to address:** Cloud SDK client ID may be blocked by Google for non-Google-distributed apps. Have fallback plan: require user-provided OAuth client ID or use GCP device code flow instead.

### Phase Ordering Rationale

- **Dependencies:** Phase 1 methods are independent and self-contained. Phase 2 Azure methods share the credential caching pattern with Phase 1's Azure CLI. Phase 3 GCP methods are fully independent but complex.
- **Risk gradient:** Phase 1 has near-zero risk (wiring existing code). Phase 2 has moderate risk (PFX parsing edge cases, device code UX relay). Phase 3 has high risk (custom OAuth2 flow, uncertain client ID reuse).
- **User value:** Phase 1 fixes 4 broken-looking auth methods immediately. Phase 2 adds enterprise-grade options. Phase 3 completes the matrix for GCP-heavy customers.
- **Pitfall avoidance:** AssumeRole credential refresh (Phase 1) prevents scan failures. PFX fallback (Phase 2) prevents customer-facing parsing errors. OAuth port management (Phase 3) prevents environment-specific failures.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 2 (Azure Device Code):** The UX relay pattern (surfacing device code to frontend) needs design validation. Two viable approaches exist; pick one during planning.
- **Phase 3 (GCP Browser OAuth):** Cloud SDK client ID reuse from a third-party binary needs testing against Google's API policies. May need to pivot to device code flow.
- **Phase 3 (GCP Workload Identity):** Hard to test without a federated environment. Consider deferring to v2.2 if test infrastructure is not available.

Phases with standard patterns (skip research-phase):
- **Phase 1 (all 4 methods):** Well-documented SDK patterns, existing code to follow, minimal unknowns.
- **Phase 2 (Azure Certificate):** Standard `azidentity` API, well-documented. Only edge case is PFX SHA256 fallback.
- **Phase 2 (AD Kerberos):** Architecture decision already made (NTLM fallback with clear messaging). Implementation is straightforward.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All deps verified in go.mod; zero new dependencies needed. Every API call verified against SDK docs. |
| Features | HIGH | Feature list derived from existing frontend definitions (mock-data.ts) and codebase analysis. |
| Architecture | HIGH | Pattern analysis based on reading existing source code. All integration points identified by file and line number. |
| Pitfalls | HIGH | Critical pitfalls verified against known SDK issues (Azure PFX SHA256 is a documented GitHub issue). |

**Overall confidence:** HIGH

### Gaps to Address

- **GCP Cloud SDK client ID reuse:** Will Google block OAuth requests using the Cloud SDK client ID from a non-Google binary? Needs live testing before committing to this approach. Fallback: user-provided OAuth client ID or device code flow.
- **PFX SHA256 fallback library:** `sslmate/go-pkcs12` is recommended but not yet verified for CGO_ENABLED=0 compatibility. Verify before adding to go.mod.
- **Azure Device Code UX:** Two approaches documented (long-poll like AWS SSO vs. separate poll endpoint). Need to pick one and verify frontend handling of long-running validate calls with intermediate display data.
- **Kerberos from non-domain-joined Windows:** The `ClientKerberos` transport with explicit realm/KDC has not been tested from a non-domain-joined machine. May surface DNS resolution issues for KDC discovery.
- **Session clone for new auth types:** `cloneSession()` must correctly handle all new credential fields and cached credential objects. Needs a verification pass after implementation.

## Sources

### Primary (HIGH confidence)
- [azidentity package documentation](https://pkg.go.dev/github.com/Azure/azure-sdk-for-go/sdk/azidentity)
- [azidentity README](https://github.com/Azure/azure-sdk-for-go/blob/main/sdk/azidentity/README.md)
- [masterzen/winrm package and GitHub](https://github.com/masterzen/winrm)
- [aws-sdk-go-v2 config and stscreds packages](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/credentials/stscreds)
- [golang.org/x/oauth2/google package](https://pkg.go.dev/golang.org/x/oauth2/google)
- [GCP Workload Identity Federation / AIP-4117](https://google.aip.dev/auth/4117)
- [WinRM HTTPS configuration](https://learn.microsoft.com/en-us/troubleshoot/windows-client/system-management-components/configure-winrm-for-https)
- Existing codebase: `server/validate.go`, `internal/scanner/*/scanner.go`, `internal/session/session.go`, `internal/orchestrator/orchestrator.go`

### Secondary (MEDIUM confidence)
- [Azure Device Code Flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [Azure additional auth methods for Go](https://learn.microsoft.com/en-us/azure/developer/go/sdk/authentication/authentication-additional-methods)
- [sslmate/go-pkcs12 (SHA256 PFX support)](https://pkg.go.dev/software.sslmate.com/src/go-pkcs12)

### Tertiary (LOW confidence)
- GCP Cloud SDK client ID reuse from third-party binary -- needs live validation
- GCP Workload Identity Federation from non-cloud environments -- needs environment testing

---
*Research completed: 2026-03-14*
*Ready for roadmap: yes*

# Architecture Patterns: Auth Method Completion (v2.1)

**Domain:** Auth method integration for Go+React cloud scanning tool
**Researched:** 2026-03-14

## Current Architecture Summary

The auth flow is a clean 4-layer pipeline:

```
Frontend (mock-data.ts)     → defines auth methods + field schemas per provider
  ↓ POST /api/v1/providers/{provider}/validate
Validate Handler (validate.go) → dispatches to per-provider validator functions
  ↓ stores credentials in session
Session (session.go)        → typed credential structs (AWSCredentials, AzureCredentials, etc.)
  ↓ orchestrator reads session, builds ScanRequest
Scanner (aws/scanner.go etc.) → buildConfig/buildCredential dispatches on auth_method
```

Each auth method needs changes in all 4 layers. The existing code already has the dispatch structure (switch on `creds["authMethod"]`) in both the validator and the scanner -- new methods slot into existing switch statements.

## Recommended Architecture: Per-Auth-Method Integration

No new components needed. Each auth method is a function added to an existing switch statement in two places: the validator and the scanner's credential builder. The pattern is already established by SSO (AWS) and browser-SSO (Azure).

### Integration Pattern Per Auth Method

Every new auth method follows the same 4-step pattern:

1. **Frontend**: Already done -- `mock-data.ts` already defines all 9 auth methods with their field schemas
2. **Validator** (`server/validate.go`): Add a case in `realXxxValidator()` that validates credentials and returns `[]SubscriptionItem`
3. **Session** (`internal/session/session.go`): Add any new fields to the credential struct (only needed for some methods)
4. **Scanner** (`internal/scanner/xxx/scanner.go`): Add a case in `buildConfig()` or `buildCredential()` that constructs the cloud SDK credential object

### Component Boundaries

| Component | Responsibility | What Changes |
|-----------|---------------|-------------|
| `frontend/src/app/components/mock-data.ts` | Auth method UI definitions | No changes -- all 9 already defined |
| `server/validate.go` | Credential validation + session storage | Add cases in `realAWSValidator`, `realAzureValidator`, `realGCPValidator`, `realADValidator` |
| `server/validate.go` → `storeCredentials()` | Maps validated creds to session structs | Add new session fields for cert/kerberos data |
| `internal/session/session.go` | Typed credential storage | Add fields for certificate data, Kerberos config, WinRM SSL flag |
| `internal/scanner/aws/scanner.go` → `buildConfig()` | AWS SDK config construction | Already has `profile` and `assume_role` cases -- just fix validators |
| `internal/scanner/azure/scanner.go` → `buildCredential()` | Azure credential construction | Add `certificate`, `az-cli`, `device-code` cases |
| `internal/scanner/gcp/scanner.go` → `buildTokenSource()` | GCP token source construction | Add `browser-oauth`, `workload-identity` cases |
| `internal/scanner/ad/scanner.go` | AD/WinRM client construction | Add Kerberos client builder, HTTPS transport |
| `internal/orchestrator/orchestrator.go` → `buildScanRequest()` | Session-to-ScanRequest mapping | Add new credential fields to switch cases |

## Detailed Auth Method Analysis

### 1. AWS CLI Profile (auth_method: "profile")

**Status:** Scanner `buildConfig()` already implements this (line 109-113 of aws/scanner.go). Validator returns "Coming soon".

**Changes needed:**
- `validate.go` → `realAWSValidator`: Replace "Coming soon" with actual validation. Use `awsconfig.LoadDefaultConfig` with `WithSharedConfigProfile(profileName)` and call `sts:GetCallerIdentity`.
- `session.go`: No changes -- `ProfileName` field already exists on `AWSCredentials`.
- `scanner.go`: No changes -- `buildConfig` case "profile" already works.

**New dependencies:** None.

**Complexity:** LOW. The scanner already works; only the validator is missing.

**Pitfall:** The `.exe` runs on the customer's Windows machine. `~/.aws/credentials` and `~/.aws/config` must exist. The validator should give a clear error ("no AWS CLI profiles found") rather than a Go stack trace. Also, CGO_ENABLED=0 is fine -- `awsconfig.LoadDefaultConfig` reads config files in pure Go.

### 2. AWS Assume Role (auth_method: "assume_role" / "assume-role")

**Status:** Scanner `buildConfig()` already implements this (line 170-197 of aws/scanner.go). Validator returns "Coming soon".

**Changes needed:**
- `validate.go` → `realAWSValidator`: Replace "Coming soon" with actual validation. Build base config from access key (or source profile), call `sts.AssumeRole`, then `sts.GetCallerIdentity` with the assumed credentials.
- `session.go`: Fields `RoleARN` and `AccessKeyID`/`SecretAccessKey` already exist. Need to add `ExternalID` field (frontend sends `externalId`). Also need `SourceProfile` field (frontend sends `sourceProfile` for profile-based assume role).
- `storeCredentials()`: Map `externalId` and `sourceProfile` to session fields.
- `scanner.go` → `buildConfig()`: Pass ExternalID to `AssumeRoleInput` if non-empty. Support source profile as base config (not just access key).
- `orchestrator.go` → `buildScanRequest()`: Add ExternalID and SourceProfile to credentials map.

**New dependencies:** None.

**Complexity:** MEDIUM. The scanner has the basic assume-role path, but the frontend sends `sourceProfile` (use a profile instead of access key as the base), `externalId`, and `roleArn` -- the scanner needs a second variant that uses a profile as the base config instead of access keys.

### 3. Azure Certificate (auth_method: "certificate")

**Status:** Frontend defines fields (`tenantId`, `clientId`, `certPath`). Validator falls through to client secret path and fails.

**Changes needed:**
- `validate.go` → `realAzureValidator`: Add `"certificate"` case. Read PEM file from `certPath`, call `azidentity.ParseCertificates()`, create `azidentity.NewClientCertificateCredential()`, list subscriptions.
- `session.go` → `AzureCredentials`: Add `CertificatePEMData []byte` field (store the raw PEM bytes, not the path -- the path might be inaccessible later). Add `CachedCredential` reuse (already exists).
- `storeCredentials()`: Read the PEM file at `certPath` and store bytes in session. Or better: cache the credential object like browser-SSO does via `azureCredCache`.
- `scanner.go` → `buildCredential()`: Add `"certificate"` case. Parse PEM from session data, create `ClientCertificateCredential`.
- `orchestrator.go` → `buildScanRequest()`: No special handling needed if credential is cached.

**New dependencies:** None -- `azidentity.ParseCertificates` and `azidentity.NewClientCertificateCredential` are in the existing `azidentity` dependency.

**Complexity:** MEDIUM. The PEM parsing has edge cases (encrypted keys not supported by `azidentity.ParseCertificates`). The validator should read the file and cache the resulting credential object in `azureCredCache` to avoid re-reading during scan.

**Pitfall:** `certPath` is a filesystem path on the customer's Windows machine. The tool must handle backslash paths (`C:\certs\cert.pem`). Since CGO_ENABLED=0, Go's `os.ReadFile` works fine. The PEM must contain both cert and private key. Error message should say "PEM file must contain both certificate and private key" if parsing fails.

### 4. Azure CLI (auth_method: "az-cli")

**Status:** Frontend defines no fields (just `tenantId` optional). Validator falls through to client secret path.

**Changes needed:**
- `validate.go` → `realAzureValidator`: Add `"az-cli"` case. Create `azidentity.NewAzureCLICredential()`, list subscriptions.
- `session.go` → `AzureCredentials`: Use existing `CachedCredential` field to store the `AzureCLICredential` object.
- `storeCredentials()`: Cache the credential in `azureCredCache` like browser-SSO does.
- `scanner.go` → `buildCredential()`: Add `"az-cli"` case. Return cached credential. Fallback: create fresh `AzureCLICredential`.
- `orchestrator.go` → `buildScanRequest()`: Pass cached credential through existing `CachedAzureCredential` side-channel.

**New dependencies:** None.

**Complexity:** LOW. `NewAzureCLICredential()` is a one-liner. The credential object implements `azcore.TokenCredential` and is cached exactly like browser-SSO.

**Pitfall:** Requires `az` CLI installed and authenticated on the customer's machine. The validator error should say "Azure CLI not found or not logged in -- run: az login" rather than a raw Go error. `NewAzureCLICredential` shells out to `az account get-access-token` -- this works on Windows with CGO_ENABLED=0.

### 5. Azure Device Code (auth_method: "device-code" / "device_code")

**Status:** Validator returns "Coming soon".

**Changes needed:**
- `validate.go` → `realAzureValidator`: Add `"device_code"` / `"device-code"` case. Create `azidentity.NewDeviceCodeCredential()` with `DeviceCodeCredentialOptions{UserPrompt: ...}`. The UserPrompt callback receives a `DeviceCodeMessage` containing a URL and code -- these must be returned to the frontend somehow.
- **New endpoint or response field**: The device code flow requires the user to visit a URL and enter a code. Two approaches:
  - **Option A (recommended):** The `realAzureDeviceCode` function opens the browser to the verification URL (like AWS SSO does) and blocks until the user completes authentication (polling internally). The UserPrompt prints the code to console. Simple, matches AWS SSO pattern.
  - **Option B:** Return the URL/code in the response and let the frontend display it. This would require a multi-step validate flow (not the current architecture).
- `session.go`: Use existing `CachedCredential` field.
- `scanner.go` → `buildCredential()`: Add `"device-code"` case. Return cached credential.

**New dependencies:** None.

**Complexity:** MEDIUM. The device code flow is inherently multi-step, but Option A (open browser, poll in handler) matches the existing AWS SSO pattern exactly.

**Pitfall:** The validate HTTP request will block for up to 120 seconds while polling for user completion. This matches AWS SSO behavior, so the frontend already handles long-running validate calls (no timeout issues). The `DeviceCodeCredential` options have a `UserPrompt` callback -- use it to log the code to the Go console and open the URL via `pkg/browser`.

### 6. GCP Browser OAuth (auth_method: "browser-oauth")

**Status:** Frontend defines no fields. Validator falls through to service account path and fails.

**Changes needed:**
- `validate.go` → `realGCPValidator`: Add `"browser-oauth"` case. This is essentially the same as `"adc"` but explicitly opens a browser. Use `google.FindDefaultCredentials` after triggering a browser-based OAuth flow.
- **Approach:** There is no built-in "open browser, get GCP token" in the Go google-cloud SDK equivalent to Azure's `InteractiveBrowserCredential`. The practical approach is:
  - **Option A (recommended):** Use a local OAuth2 redirect flow. Start a localhost HTTP server, build an OAuth2 AuthCodeURL, open the browser, receive the code on the redirect, exchange for token. Cache the resulting `oauth2.TokenSource`.
  - **Option B:** Treat this as "ADC" and tell the user to run `gcloud auth application-default login` first. But this contradicts the "browser-oauth" label.
- `session.go`: Use existing `CachedTokenSource` field.
- `scanner.go` → `buildTokenSource()`: Add `"browser-oauth"` case. Return cached token source (same as ADC path).

**New dependencies:** Need a Google OAuth2 client ID. Use the Google Cloud CLI's well-known client ID (`764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com`) or register a desktop app.

**Complexity:** HIGH. This is the hardest auth method because Go's google-cloud SDK does not provide a `NewInteractiveBrowserCredential()` equivalent. The implementation requires a manual OAuth2 authorization code flow with localhost redirect listener.

**Pitfall:** The OAuth2 client ID matters. Using Google's "desktop" type client for installed apps is standard but needs the right scopes. The redirect listener must use `127.0.0.1` (not `0.0.0.0`) to avoid Windows Firewall dialog -- same as the main app server.

### 7. GCP Workload Identity Federation (auth_method: "workload-identity")

**Status:** Frontend defines fields (`projectNumber`, `poolId`, `providerId`, `serviceAccountEmail`). Validator falls through to service account path.

**Changes needed:**
- `validate.go` → `realGCPValidator`: Add `"workload-identity"` case. Construct the external account JSON configuration, use `google.CredentialsFromJSON()` with the generated config JSON.
- `session.go` → `GCPCredentials`: Add `WorkloadIdentityConfig string` field to store the generated JSON config.
- `storeCredentials()`: Build the JSON config from frontend fields and store it.
- `scanner.go` → `buildTokenSource()`: Add `"workload-identity"` case. Parse config JSON with `google.CredentialsFromJSON()`.

**New dependencies:** None -- `golang.org/x/oauth2/google` handles external account configs natively.

**Complexity:** MEDIUM. The JSON config construction follows a documented schema (AIP-4117). The tricky part is that workload identity federation requires an external token source (AWS STS, Azure IMDS, or OIDC provider) -- this only works when the tool runs *inside* that cloud environment. For a Windows `.exe` handed to a customer, this is a niche case.

**Pitfall:** Workload identity federation only works when the tool runs inside the federated environment (e.g., on an EC2 instance that has an OIDC provider configured). For a pre-sales `.exe` running on a customer laptop, this will almost always fail. The error message should be clear: "Workload Identity Federation requires running inside a federated cloud environment."

### 8. AD Kerberos (auth_method: "kerberos")

**Status:** Frontend defines fields (just `servers`). Validator falls through to NTLM path silently.

**Changes needed:**
- `validate.go` → `realADValidator`: Add `"kerberos"` case. Use `winrm.ClientKerberos` with the domain realm. The existing code always uses `BuildNTLMClient` -- need a parallel `BuildKerberosClient` function.
- `internal/scanner/ad/scanner.go`: Add `BuildKerberosClient(host, realm, krbConf string) (*winrm.Client, error)` that uses `ClientKerberos` transport decorator.
- `session.go` → `ADCredentials`: No username/password needed for Kerberos (uses current Windows session). But `Realm` (domain) and potentially `KrbConf` path are needed. The `Domain` field already exists.
- `scanner.go` → `scanOneDC()`: Dispatch on `auth_method` to use either `BuildNTLMClient` or `BuildKerberosClient`.

**New dependencies:** `jcmturner/gokrb5` -- the `masterzen/winrm` library's `ClientKerberos` uses this for pure-Go Kerberos. This is CGO_ENABLED=0 compatible.

**Complexity:** HIGH. Kerberos requires: (1) the machine to be domain-joined (or have a valid krb5.conf and kinit'd ticket), (2) DNS SRV records for the domain, (3) clock sync. For a `.exe` handed to a customer, this means the customer must run it on a domain-joined Windows machine. The validator must give a clear error if Kerberos fails rather than silently falling through to NTLM.

**Pitfall:** On Windows, the Kerberos credential cache location differs from Linux (`KRB5CCNAME` vs Windows credential manager). `jcmturner/gokrb5` v8 supports Windows credential cache via SSPI, but this requires CGO. Pure Go Kerberos requires a keytab or password -- negating the "current user" experience. The practical fallback: accept username/password but use Kerberos protocol instead of NTLM. Document clearly that "current user" Kerberos (no password) only works with CGO, which is prohibited.

**Architecture decision:** Kerberos auth in this tool should accept username + password + domain, but use the Kerberos protocol (via `ClientKerberos`) instead of NTLM. The "no password" variant (SSPI/integrated auth) is impossible without CGO. The frontend's "Use your current Windows domain session" description is misleading and should be updated.

### 9. AD PowerShell Remoting SSL (auth_method: "powershell-remote")

**Status:** Frontend defines fields (`servers`, `username`, `password`, `useSSL`). Validator falls through to NTLM path silently, ignoring `useSSL`.

**Changes needed:**
- `validate.go` → `realADValidator`: Add `"powershell-remote"` case. When `useSSL` is true, use port 5986 with TLS. When false, identical to NTLM path.
- `internal/scanner/ad/scanner.go`: Add `BuildNTLMClientSSL(host, username, password string) (*winrm.Client, error)` that uses port 5986, `useTLS: true` in `winrm.NewEndpoint`.
- `session.go` → `ADCredentials`: Add `UseSSL bool` field.
- `scanner.go` → `scanOneDC()`: Dispatch on `UseSSL` to use SSL or plain endpoint.
- `ad/scanner.go` constant: Change hardcoded `winrmPort = 5985` to use port from credentials.

**New dependencies:** None.

**Complexity:** LOW. `winrm.NewEndpoint` already accepts a `useTLS` boolean and a port number. The only change is passing `true` for TLS and `5986` for port. Self-signed certs are common on DCs, so `InsecureSkipVerify: true` should be an option (controlled by a `skipTLSVerify` field, or always true for WinRM since DCs rarely have valid public certs).

**Pitfall:** WinRM over HTTPS requires the Windows server to have a WinRM HTTPS listener configured (`winrm quickconfig -transport:https`). Many DCs only have HTTP (5985) enabled. The validator error should distinguish "connection refused on 5986" (no HTTPS listener) from "TLS handshake failed" (cert issue).

## Data Flow Changes

### New Session Fields Required

```go
// AWSCredentials — add:
ExternalID    string  // for assume-role
SourceProfile string  // for assume-role with profile base

// AzureCredentials — add:
CertificatePEM []byte  // raw PEM data for certificate auth
// CachedCredential already handles az-cli and device-code

// GCPCredentials — add:
WorkloadIdentityJSON string  // generated external account config

// ADCredentials — add:
UseSSL    bool    // WinRM over HTTPS (port 5986)
KrbConf   string  // Kerberos config path (optional)
```

### ScanRequest Side-Channel Additions

The `scanner.ScanRequest` struct already has `CachedAzureCredential` and `CachedGCPTokenSource` fields. No new side-channels are needed -- the new Azure auth methods (certificate, az-cli, device-code) all produce `azcore.TokenCredential` objects that fit into the existing `CachedAzureCredential` field.

### orchestrator.go Changes

`buildScanRequest()` needs to map the new session fields to `req.Credentials`:
- AWS: add `external_id`, `source_profile`
- Azure: no changes (cached credential handles everything)
- GCP: add `workload_identity_json`
- AD: add `use_ssl`, `krb_conf`

## Patterns to Follow

### Pattern 1: Cached Credential Object (Azure/GCP)

**What:** The validator creates a live credential object (e.g., `azcore.TokenCredential`) and caches it in a process-level map. A cache key is stored in the credentials map. `storeCredentials()` retrieves the object from the cache and attaches it to the session. The scanner receives it via `ScanRequest.CachedAzureCredential` (or `CachedGCPTokenSource`).

**When:** Any auth method that produces a non-serializable credential object (browser tokens, CLI credentials, device code tokens).

**Why:** Prevents second browser popups, avoids re-running CLI commands, keeps credential objects alive for the scan.

**Example (already in codebase):**
```go
// validate.go — realAzureBrowserSSO
cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
azureCredCacheMu.Lock()
azureCredCache[cacheKey] = cred
azureCredCacheMu.Unlock()
creds["azure_cred_cache_key"] = cacheKey
```

**Use for:** Azure certificate, Azure CLI, Azure device code, GCP browser OAuth.

### Pattern 2: Browser-Open-Then-Poll (AWS SSO / Azure Device Code)

**What:** The validator opens the system browser to a verification URL, then polls the cloud API until the user completes authentication (with timeout). The HTTP handler blocks for up to 120 seconds.

**When:** Device authorization flows where the user must authenticate in a browser on this or another device.

**Example (already in codebase):** `realAWSSSO()` in validate.go (lines 328-454).

**Use for:** Azure device code flow.

### Pattern 3: Auth-Method Switch Dispatch

**What:** Both the validator and the scanner have a `switch creds["authMethod"]` (validator) / `switch creds["auth_method"]` (scanner) that dispatches to method-specific code. New methods add cases to existing switches.

**When:** Always -- every auth method follows this pattern.

**Note the key naming difference:** Frontend sends `authMethod` (camelCase), validator merges it as `creds["authMethod"]`. But the scanner reads `creds["auth_method"]` (snake_case). The orchestrator's `buildScanRequest()` writes `auth_method` from `sess.XXX.AuthMethod`. This is consistent but confusing -- do not change it, just be aware.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Silent Fallthrough

**What:** Auth method not recognized, falls through to default case which tries a different auth method.

**Why bad:** The current Azure certificate and GCP workload-identity paths do exactly this -- they fall through to client-secret / service-account and produce confusing "tenantId/clientId/clientSecret required" errors.

**Instead:** Every unrecognized auth method should return a clear error: `fmt.Errorf("auth method %q not yet implemented", method)`.

### Anti-Pattern 2: Reading Files During Scan

**What:** Scanner reads a certificate file from `certPath` during the scan, long after the validate step.

**Why bad:** The file might have been deleted, moved, or the path might be different in the scan context. Also violates the principle that credentials are captured during validation.

**Instead:** Read the file during validation, store the bytes in the session, pass bytes to the scanner via `ScanRequest.Credentials` or a cached credential object.

### Anti-Pattern 3: Adding New ScanRequest Side-Channels

**What:** Adding new typed fields to `scanner.ScanRequest` for every new auth method (e.g., `CachedAzureCertCredential`, `CachedGCPWorkloadTokenSource`).

**Why bad:** The existing side-channels (`CachedAzureCredential`, `CachedGCPTokenSource`) are already typed as interfaces (`azcore.TokenCredential`, `oauth2.TokenSource`). All Azure credential types implement `azcore.TokenCredential`. All GCP credential types produce `oauth2.TokenSource`.

**Instead:** Reuse the existing side-channels. Every Azure auth method produces an `azcore.TokenCredential` -- use `CachedAzureCredential` for all of them.

## Suggested Build Order

Based on dependency analysis and complexity:

### Phase 1: Low-Hanging Fruit (3 methods, all LOW complexity)

Build order within phase does not matter -- these are independent.

1. **AWS CLI Profile** — Scanner already works; just implement the validator. One function, ~30 lines.
2. **Azure CLI** — One-liner credential creation. Cache in existing `azureCredCache`.
3. **AD PowerShell SSL** — Change port and TLS flag in `winrm.NewEndpoint`. Add `UseSSL` to session.

**Rationale:** These three clear the "Coming soon" and "silent fallthrough" issues with minimal risk. Each is <50 lines of new code.

### Phase 2: Medium Complexity (3 methods)

4. **AWS Assume Role** — Scanner partially works but needs ExternalID and source-profile support. Add new session fields, update validator.
5. **Azure Device Code** — Follow the AWS SSO pattern (open browser, poll). Use `azidentity.NewDeviceCodeCredential`.
6. **Azure Certificate** — Read PEM, parse with `azidentity.ParseCertificates`, create credential, cache it.

**Rationale:** These all follow established patterns (cached credentials, browser-open-then-poll) but require more careful error handling and session field additions.

### Phase 3: Hard / Niche (3 methods)

7. **GCP Workload Identity Federation** — Construct external account JSON config, use `google.CredentialsFromJSON`. Niche use case (only works inside federated environments).
8. **AD Kerberos** — Requires `jcmturner/gokrb5` dependency, `ClientKerberos` transport. Need to update frontend description (no true "integrated auth" without CGO).
9. **GCP Browser OAuth** — No SDK equivalent to Azure's InteractiveBrowserCredential. Requires manual OAuth2 authorization code flow with localhost redirect server.

**Rationale:** These three have the highest implementation risk. Kerberos has the CGO constraint issue. GCP Browser OAuth requires building a custom OAuth2 flow. Workload Identity is architecturally simple but hard to test without a federated environment.

## Files Modified Per Auth Method (Summary)

| Auth Method | validate.go | session.go | scanner/*.go | orchestrator.go | mock-data.ts |
|-------------|-------------|------------|--------------|-----------------|-------------|
| AWS Profile | +30 LOC | -- | -- | -- | -- |
| AWS Assume Role | +40 LOC | +2 fields | +20 LOC | +2 lines | -- |
| Azure Certificate | +50 LOC | +1 field | +15 LOC | -- | -- |
| Azure CLI | +25 LOC | -- | +10 LOC | -- | -- |
| Azure Device Code | +60 LOC | -- | +5 LOC | -- | -- |
| GCP Browser OAuth | +80 LOC | -- | +5 LOC | -- | -- |
| GCP Workload Identity | +40 LOC | +1 field | +15 LOC | +1 line | -- |
| AD Kerberos | +40 LOC | +1 field | +30 LOC (new builder) | +2 lines | Update desc |
| AD PowerShell SSL | +15 LOC | +1 field | +20 LOC (new builder) | +1 line | -- |

**Total estimated:** ~380 LOC Go changes, 1 frontend text update.

## Sources

- [azidentity package (DeviceCodeCredential, ClientCertificateCredential, AzureCLICredential)](https://pkg.go.dev/github.com/Azure/azure-sdk-for-go/sdk/azidentity) -- HIGH confidence
- [masterzen/winrm ClientKerberos](https://github.com/masterzen/winrm) -- HIGH confidence
- [golang.org/x/oauth2/google (CredentialsFromJSON, external account)](https://pkg.go.dev/golang.org/x/oauth2/google) -- HIGH confidence
- [GCP Workload Identity Federation JSON config (AIP-4117)](https://google.aip.dev/auth/4117) -- HIGH confidence
- [golang.org/x/oauth2/google/externalaccount](https://pkg.go.dev/golang.org/x/oauth2/google/externalaccount) -- HIGH confidence
- [Azure additional auth methods for Go](https://learn.microsoft.com/en-us/azure/developer/go/sdk/authentication/authentication-additional-methods) -- MEDIUM confidence

# Technology Stack: Auth Method Completion (v2.1)

**Project:** UDDI-GO Token Calculator
**Researched:** 2026-03-14

## Key Finding: Zero New Dependencies Required

Every auth method can be implemented using libraries already in `go.mod`. No new `go get` commands needed. This is the single most important finding -- it means zero risk of CGO contamination, no binary size increase, and no new supply-chain surface.

## Existing Dependencies Used Per Auth Method

### AWS Auth Methods

| Auth Method | Library | Already In go.mod | Mechanism |
|-------------|---------|-------------------|-----------|
| CLI Profile | `aws-sdk-go-v2/config` | Yes (v1.32.11) | `awsconfig.WithSharedConfigProfile(name)` |
| Assume Role (Cross-Account) | `aws-sdk-go-v2/service/sts` | Yes (v1.41.8) | `sts.AssumeRole()` with static creds |

**Status:** Both already implemented in `buildConfig()` at `internal/scanner/aws/scanner.go:109-197`. The "profile" case loads `~/.aws/credentials` + `~/.aws/config` via `LoadDefaultConfig` with `WithSharedConfigProfile`. The "assume_role" case builds a base config from access keys then calls `sts.AssumeRole`. Both return valid `aws.Config` objects. The frontend was returning "Coming soon" but the backend is ready.

**Confidence:** HIGH -- verified by reading the existing source code directly.

### Azure Auth Methods

| Auth Method | Library | Already In go.mod | Function |
|-------------|---------|-------------------|----------|
| Certificate-based SP | `azidentity` | Yes (v1.13.1) | `azidentity.NewClientCertificateCredential()` |
| az-cli | `azidentity` | Yes (v1.13.1) | `azidentity.NewAzureCLICredential()` |
| Device Code Flow | `azidentity` | Yes (v1.13.1) | `azidentity.NewDeviceCodeCredential()` |

#### Azure Certificate-based Service Principal

`azidentity.ParseCertificates(data, password)` handles both PEM and PKCS#12 (PFX) formats. Returns `[]*x509.Certificate` and `crypto.PrivateKey` which feed into `NewClientCertificateCredential(tenantID, clientID, certs, key, nil)`.

**Integration point:** Add a `"certificate"` case to `buildCredential()` in `internal/scanner/azure/scanner.go`. The certificate bytes come from the frontend via the credentials map (base64-encoded PEM/PFX uploaded through the UI). Parse with `azidentity.ParseCertificates()`, then construct the credential.

**Limitation:** `ParseCertificates` does not support PEM-encrypted private keys or PKCS#12 with SHA256 MAC. This covers 95%+ of real-world certificates. Document the limitation; do not add a workaround library.

**Confidence:** HIGH -- `azidentity.ParseCertificates` and `NewClientCertificateCredential` documented in official azidentity package.

#### Azure az-cli

`azidentity.NewAzureCLICredential(nil)` authenticates using the token from a prior `az login`. No tenant/client/secret needed -- it reads from the az CLI token cache.

**Integration point:** Add an `"az-cli"` case to `buildCredential()`. Optionally pass `AzureCLICredentialOptions{TenantID: tenantID}` if the user specifies a tenant. The credential implements `azcore.TokenCredential` like all others, so no downstream changes needed.

**Design decision: Use NewAzureCLICredential, NOT NewDefaultAzureCredential.** DefaultAzureCredential tries multiple auth methods in a chain (env vars, managed identity, CLI, etc.) which contradicts the explicit-auth-method architecture. The project already has a key decision: "Never DefaultAzureCredential." Using `NewAzureCLICredential` directly respects the user's explicit choice.

**Confidence:** HIGH -- documented in azidentity README and pkg.go.dev.

#### Azure Device Code Flow

`azidentity.NewDeviceCodeCredential(opts)` implements the OAuth 2.0 device authorization grant. The user is given a URL + code to enter in any browser.

**Integration point:** Add a `"device-code"` case to `buildCredential()`. The `DeviceCodeCredentialOptions.UserPrompt` callback receives the device code message (URL + code). This message must be sent back to the frontend so the user can see it. Two approaches:

1. **Recommended:** Store the prompt text in a channel/callback that the validate endpoint reads and returns to the frontend. The frontend displays it.
2. **Alternative:** Call `cred.Authenticate(ctx)` during validation, capture the prompt via `UserPrompt`, return it in the validate response, and cache the credential for scan time.

The credential must be cached (like browser-sso) because the device code is single-use.

**Confidence:** HIGH -- documented in azidentity package. The `UserPrompt` callback mechanism is the standard pattern.

### GCP Auth Methods

| Auth Method | Library | Already In go.mod | Function |
|-------------|---------|-------------------|----------|
| Browser OAuth | `golang.org/x/oauth2` | Yes (v0.36.0) | `oauth2.Config.Exchange()` with localhost redirect |
| Workload Identity Federation | `golang.org/x/oauth2/google` | Yes (v0.36.0) | `google.CredentialsFromJSON()` with external_account JSON |

#### GCP Browser OAuth (User Credentials)

Standard OAuth2 three-legged flow: open browser to Google consent screen, receive auth code via localhost redirect, exchange for tokens.

**Implementation pattern:**
1. Create an `oauth2.Config` with `ClientID`, `ClientSecret` (from a GCP OAuth "Desktop" client), `RedirectURL: "http://localhost:{port}/callback"`, and scopes `compute.readonly` + `dns.readonly`.
2. Start a temporary HTTP listener on localhost for the callback.
3. Open browser to `config.AuthCodeURL(state)`.
4. Receive the auth code on the callback handler.
5. Exchange for `oauth2.Token` via `config.Exchange(ctx, code)`.
6. Build `oauth2.TokenSource` from the token.

**Integration point:** Add a `"browser-oauth"` case to `buildTokenSource()` in the GCP scanner. The validate endpoint performs the browser flow, caches the resulting `oauth2.TokenSource` in `CachedGCPTokenSource` (same pattern as ADC). The scanner reads from cache.

**Design note:** The user must provide a GCP OAuth Client ID + Secret (created in the GCP Console under "OAuth 2.0 Client IDs" as a "Desktop application" type). These are NOT service account credentials. The frontend form must collect `client_id` and `client_secret` for this auth method.

**Confidence:** MEDIUM -- standard OAuth2 pattern well-documented in `golang.org/x/oauth2`, but the localhost-redirect flow for GCP specifically requires a GCP OAuth Desktop client configuration that the user must set up. This is more complex than other auth methods from a UX perspective.

#### GCP Workload Identity Federation

`google.CredentialsFromJSON(ctx, jsonBytes, scopes...)` already handles `type: "external_account"` JSON configurations natively. The JSON config file is generated by `gcloud iam workload-identity-pools create-cred-config` and contains the federation provider URL, audience, subject token source, and service account impersonation URL.

**Integration point:** Add a `"workload-identity"` case to `buildTokenSource()`. Accept the credential configuration JSON from the frontend (user pastes it or uploads it). Parse with `google.CredentialsFromJSON()` -- the exact same function already used for service account JSON. The `type` field in the JSON distinguishes service_account from external_account internally.

**Important:** `google.CredentialsFromJSON` is deprecated in favor of `google.CredentialsFromJSONWithParams` due to a security concern about unvalidated credential configs. Since this tool only accepts configs from its own UI (not untrusted external sources), the security concern does not apply. However, using `CredentialsFromJSONWithParams` is straightforward and avoids deprecation warnings:

```go
google.CredentialsFromJSONWithParams(ctx, jsonBytes, google.CredentialsParams{
    Scopes: []string{scopeComputeReadonly, scopeDNSReadonly},
})
```

**Confidence:** HIGH -- `google.CredentialsFromJSON` / `CredentialsFromJSONWithParams` natively parses external_account JSON. Verified via official golang.org/x/oauth2/google documentation and AIP-4117.

### AD Auth Methods

| Auth Method | Library | Already In go.mod | Mechanism |
|-------------|---------|-------------------|-----------|
| Kerberos via WinRM | `masterzen/winrm` + `jcmturner/gokrb5/v8` | Yes (both) | `winrm.ClientKerberos` transport decorator |
| PowerShell Remoting (HTTPS) | `masterzen/winrm` | Yes | `winrm.NewEndpoint(host, 5986, true, ...)` |

#### AD Kerberos via WinRM

The `masterzen/winrm` library exports `ClientKerberos` which uses `jcmturner/gokrb5/v8` for Kerberos authentication. Both are already indirect dependencies in go.mod (gokrb5 v8.4.4).

**Integration pattern:**
```go
endpoint := winrm.NewEndpoint(host, 5985, false, false, nil, nil, nil, winrmTimeout)
params := *winrm.DefaultParameters
params.TransportDecorator = func() winrm.Transporter {
    return &winrm.ClientKerberos{
        Username: username,
        Password: password,
        Hostname: host,
        Realm:    realm,      // e.g., "CORP.EXAMPLE.COM"
        Port:     5985,
        Proto:    "http",
        KrbConf:  krbConfPath, // path to /etc/krb5.conf or user-provided config
        SPN:      "HTTP/" + host,
    }
}
client, err := winrm.NewClientWithParameters(endpoint, username, password, &params)
```

**Critical constraint -- CGO_ENABLED=0 compatibility:** `jcmturner/gokrb5/v8` is pure Go. No CGO needed. This is confirmed by the existing go.mod (it is already an indirect dependency that builds with CGO_ENABLED=0).

**Critical constraint -- Kerberos requires:**
1. A `krb5.conf` file (realm/KDC mapping). The user must either have one on the machine or paste the config into the UI.
2. The client machine must be able to reach the KDC (domain controller) on port 88.
3. DNS must resolve the realm to KDCs (or the krb5.conf must specify them explicitly).

**Design decision:** Accept `krb5.conf` content as a text field in the UI. Write it to a temp file, pass the path to `ClientKerberos.KrbConf`, delete after scan. This avoids requiring the user to have a pre-existing krb5.conf on their Windows machine.

**Alternatively:** `ClientKerberos` also supports `KrbCCache` (credential cache path) for ticket-based auth without password. This is a secondary option for users who have already run `kinit`.

**Confidence:** MEDIUM -- `winrm.ClientKerberos` is documented and exported. However, real-world Kerberos from a non-domain-joined Windows machine running a standalone .exe is unusual. The krb5.conf and KDC reachability requirements make this inherently more fragile than NTLM. The existing project note ("Kerberos requires a domain-joined client machine") is partially true -- it does not strictly require domain-join, but it requires Kerberos infrastructure access.

#### AD PowerShell Remoting via WinRM (SSL/HTTPS)

WinRM over HTTPS uses port 5986 with TLS. The `masterzen/winrm` library supports this natively via `NewEndpoint`.

**Integration pattern:**
```go
endpoint := winrm.NewEndpoint(host, 5986, true, insecure, caCert, nil, nil, winrmTimeout)
// true = HTTPS, insecure = skip cert verification
// caCert = optional CA cert bytes for verifying the server's TLS cert
```

Then use the same NTLM encryption transport (`winrm.NewEncryption("ntlm")`) or Kerberos transport as before. HTTPS provides transport-level encryption; NTLM/Kerberos provides message-level encryption on top.

**Integration point:** Modify `BuildNTLMClient` (or create `BuildHTTPSClient`) to accept `useSSL bool` and `skipVerify bool` parameters. When `useSSL` is true:
- Use port 5986 instead of 5985
- Set `https: true` in `NewEndpoint`
- Optionally accept a CA certificate from the UI for server cert validation
- The `insecure` flag allows skipping cert verification (common in enterprise environments with self-signed certs)

**Confidence:** HIGH -- `NewEndpoint` HTTPS support is documented in pkg.go.dev with code examples. Port 5986 is standard WinRM HTTPS.

## Recommended Stack (No Changes)

### Core Framework (Unchanged)
| Technology | Version | Purpose | Status |
|------------|---------|---------|--------|
| Go | 1.24+ | Runtime | Existing |
| chi/v5 | v5.2.5 | HTTP router | Existing |
| embed.FS | stdlib | UI asset embedding | Existing |

### Cloud SDKs (Unchanged)
| Technology | Version | Purpose | Auth Methods Served |
|------------|---------|---------|---------------------|
| aws-sdk-go-v2/config | v1.32.11 | AWS config loading | CLI Profile |
| aws-sdk-go-v2/credentials | v1.19.11 | Static creds | Access Key, Assume Role |
| aws-sdk-go-v2/service/sts | v1.41.8 | STS AssumeRole | Assume Role |
| azidentity | v1.13.1 | Azure auth | Certificate SP, az-cli, Device Code |
| golang.org/x/oauth2 | v0.36.0 | OAuth2 flows | GCP Browser OAuth |
| golang.org/x/oauth2/google | (same module) | GCP credentials | Workload Identity |

### WinRM (Unchanged)
| Technology | Version | Purpose | Auth Methods Served |
|------------|---------|---------|---------------------|
| masterzen/winrm | v0.0.0-20250927 | WinRM client | Kerberos, HTTPS |
| jcmturner/gokrb5/v8 | v8.4.4 (indirect) | Kerberos auth | Kerberos |
| bodgit/ntlmssp | v0.0.0-20240506 (indirect) | NTLM encryption | HTTPS+NTLM |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Azure CLI auth | `NewAzureCLICredential` | `NewDefaultAzureCredential` | Project policy: never DefaultAzureCredential. Explicit auth only. |
| GCP WIF | `google.CredentialsFromJSONWithParams` | `google.CredentialsFromJSON` | Deprecated; trivial to use the non-deprecated variant |
| GCP Browser OAuth | Manual localhost-redirect flow | `gcloud auth application-default login` | Requires gcloud CLI installed; contradicts "no setup" goal |
| AD Kerberos | `winrm.ClientKerberos` (in masterzen/winrm) | `dpotapov/go-kerberos` or custom SPNEGO | masterzen/winrm already integrates gokrb5; no reason to add another lib |
| AD HTTPS transport | `NewEndpoint(host, 5986, true, ...)` | Custom TLS dialer | Built-in to masterzen/winrm; no custom code needed |

## What NOT to Add

| Library | Why Avoid |
|---------|-----------|
| `dpotapov/winrm-auth-ntlm` | Not in go.mod despite being in MEMORY.md. NTLM is handled by bodgit/ntlmssp via masterzen/winrm's built-in encryption. Do not add. |
| Any CGO-dependent Kerberos lib | CGO_ENABLED=0 is mandatory. gokrb5 is pure Go. |
| `cloud.google.com/go/auth/credentials` | Newer GCP auth library, but project already uses golang.org/x/oauth2/google consistently. Mixing would create confusion. |
| `msal-go` directly | azidentity wraps MSAL internally. Do not import directly. |
| Any external OAuth server lib | GCP browser OAuth needs only a 10-line localhost HTTP handler + stdlib net/http. |

## Installation

```bash
# No new dependencies to install.
# All 9 auth methods use existing go.mod entries.
go mod tidy  # Only if indirect deps need cleanup
```

## Integration Summary by Scanner File

| File | Changes Needed |
|------|---------------|
| `internal/scanner/aws/scanner.go` | None -- profile and assume_role cases already exist |
| `internal/scanner/azure/scanner.go` | Add 3 cases to `buildCredential()`: certificate, az-cli, device-code |
| `internal/scanner/gcp/scanner.go` | Add 2 cases to `buildTokenSource()`: browser-oauth, workload-identity |
| `internal/scanner/ad/scanner.go` | Add auth_method routing to `Scan()` and `scanOneDC()`. New `BuildKerberosClient` and `BuildHTTPSClient` functions alongside existing `BuildNTLMClient`. |
| `server/validate.go` | Add validation logic for each new auth method |
| `internal/scanner/provider.go` | No changes -- `CachedAzureCredential` and `CachedGCPTokenSource` already cover caching needs |

## Sources

- [azidentity package documentation](https://pkg.go.dev/github.com/Azure/azure-sdk-for-go/sdk/azidentity) -- HIGH confidence
- [azidentity README](https://github.com/Azure/azure-sdk-for-go/blob/main/sdk/azidentity/README.md) -- HIGH confidence
- [masterzen/winrm package documentation](https://pkg.go.dev/github.com/masterzen/winrm) -- HIGH confidence
- [masterzen/winrm GitHub](https://github.com/masterzen/winrm) -- HIGH confidence
- [masterzen/winrm kerberos.go source](https://github.com/masterzen/winrm/blob/master/kerberos.go) -- HIGH confidence
- [golang.org/x/oauth2/google package](https://pkg.go.dev/golang.org/x/oauth2/google) -- HIGH confidence
- [GCP Workload Identity Federation docs](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-providers) -- HIGH confidence
- [AIP-4117: External Account Credentials](https://google.aip.dev/auth/4117) -- HIGH confidence
- [Azure Device Code Flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) -- HIGH confidence
- [WinRM HTTPS configuration](https://learn.microsoft.com/en-us/troubleshoot/windows-client/system-management-components/configure-winrm-for-https) -- HIGH confidence
- Existing source code at `internal/scanner/aws/scanner.go`, `internal/scanner/azure/scanner.go`, `internal/scanner/gcp/scanner.go`, `internal/scanner/ad/scanner.go` -- HIGH confidence (primary source)

# Feature Landscape: Auth Method Completion (v2.1)

**Domain:** Authentication methods for cloud/directory infrastructure scanner
**Researched:** 2026-03-14

## Table Stakes

Features users expect when an auth method appears in the UI dropdown. Missing = broken UX (user selects method, gets confusing error).

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **AWS CLI Profile** | Profile selector is the most basic AWS auth after access keys. Users who have `~/.aws/credentials` configured expect it to work. | Low | Already implemented in scanner (`buildConfig` case "profile"). Only the validate handler returns "Coming soon". Fix: call `awsconfig.LoadDefaultConfig` with `WithSharedConfigProfile`, then `sts:GetCallerIdentity`. |
| **AWS Assume Role** | Cross-account scanning is standard enterprise pattern. Role ARN field is already in the UI. | Low | Already implemented in scanner (`buildConfig` case "assume_role"). Validate handler returns "Coming soon". Fix: build base config from source credentials, call `sts:AssumeRole`, return target account ID. Frontend already sends `roleArn`, `sourceProfile`. |
| **Azure Service Principal (Certificate)** | PFX/PEM certificate auth is standard for production Azure service principals. UI already shows field for cert path. | Medium | `azidentity.NewClientCertificateCredential` accepts tenant, client, certs, key. Must read PEM/PFX file from disk (user provides path). PFX needs `crypto/pkcs12` parsing. Session needs new `CertPath` field. |
| **Azure CLI (`az login`)** | Simplest Azure auth for users who already have `az` installed. No fields needed. | Low | `azidentity.NewAzureCLICredential` reads the existing `az login` token cache. Zero user input. Cache the credential like browser-sso. |
| **Azure Device Code Flow** | Required for headless/remote scenarios where browser popup is impossible (SSH sessions, VMs). | Medium | `azidentity.NewDeviceCodeCredential` with callback that returns a user code + URL. Backend must relay the code to the frontend. Needs a new response field or SSE event to display the code. |
| **AD NTLM (via "kerberos" selection)** | Currently silently falls through to NTLM. Users selecting "Kerberos" should get explicit feedback. | Low | See Kerberos entry in Differentiators. At minimum: detect auth_method=kerberos, return clear error explaining requirements, or gracefully fall through with a warning message. |
| **AD PowerShell Remoting (WinRM/HTTPS)** | Currently ignores `useSSL` flag. Users selecting this method expect HTTPS on port 5986. | Low-Med | `winrm.NewEndpoint(host, 5986, true, ...)` with TLS config. Need to handle self-signed certs (common in enterprise). Add `InsecureSkipVerify` option. Same NTLM auth underneath. |

## Differentiators

Features that set the tool apart. Not strictly expected from a "token calculator" but valuable for enterprise adoption.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **AD Kerberos (real)** | Domain-joined Windows machines can authenticate without typing credentials. Zero-friction for IT admins running the .exe on their workstation. | High | `winrm.NewEncryption("kerberos")` exists in masterzen/winrm (jcmturner/gokrb5 already in go.mod as indirect dep). **BUT**: requires KRB5_CONFIG or auto-discovery via DNS SRV records, valid TGT from Windows credential cache. CGO_ENABLED=0 constraint means no OS Kerberos integration -- must use pure-Go gokrb5 which reads krb5.conf. Practical only on domain-joined Windows where krb5.conf or DNS SRV are available. |
| **GCP Browser OAuth** | Mirrors the existing AWS SSO and Azure Browser SSO flows. Users get consistent UX across all 3 cloud providers. | Medium | Requires running a localhost HTTP server for OAuth2 callback (like Azure browser-sso does via azidentity). Use `golang.org/x/oauth2` with GCP OAuth2 endpoints. Need a GCP OAuth2 client ID -- can use the well-known "Cloud SDK" client ID (`764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com`). Cache the TokenSource like ADC does. |
| **GCP Workload Identity Federation** | Enables scanning GCP from AWS/Azure/on-prem without service account keys. Enterprise security teams prefer keyless auth. | High | Requires constructing a credential config JSON pointing to the external identity provider. `google.CredentialsFromJSON` can parse WIF config files, but user must provide the config or the individual fields (project number, pool ID, provider ID, service account email). Complex validation: must exchange external token, then impersonate service account. |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **DefaultAzureCredential** | Existing architectural decision: picks up ambient credentials from dev machine, bypasses user-supplied creds. Violates single-user security model. | Keep explicit credential types (ClientSecret, ClientCert, CLI, Browser, DeviceCode). |
| **AWS Instance Profile / IMDS auth** | Tool runs on customer laptops (Windows .exe), not on EC2 instances. Adding IMDS auth creates confusion. | Omit from UI. If user is on EC2, they can use AWS CLI Profile which picks up instance role. |
| **Stored/saved credentials** | Credentials must never persist to disk. Violates core security constraint. | In-memory only for scan duration, zeroed after scan completes. |
| **Kerberos keytab upload** | Adds file management complexity, keytabs contain long-lived secrets on disk. | Use integrated Windows auth (current TGT) for Kerberos, or NTLM with username/password. |
| **GCP OAuth2 with custom client ID** | Requires users to create their own OAuth2 app registration. Defeats the "double-click and go" value prop. | Use the well-known Cloud SDK client ID. |
| **Multi-factor challenge relay** | Intercepting/relaying MFA challenges adds massive complexity and security liability. | Let the browser handle MFA natively (browser-sso, browser-oauth flows handle this automatically). |

## Feature Dependencies

```
AWS CLI Profile → (none, standalone)
AWS Assume Role → AWS CLI Profile OR AWS Access Key (needs base credentials to call STS)
Azure Certificate → (none, standalone)
Azure CLI → (none, requires external `az login`)
Azure Device Code → UI change to display device code + URL to user
GCP Browser OAuth → localhost callback server (similar to Azure browser-sso)
GCP Workload Identity → external identity provider config
AD Kerberos → domain-joined Windows, DNS SRV or krb5.conf
AD PowerShell Remoting → TLS certificate handling
```

## Detailed Auth Method Analysis

### 1. AWS CLI Profile

**How it works:** Reads `~/.aws/credentials` and `~/.aws/config` to find a named profile. The profile may contain static credentials, SSO config, or assume-role chain.

**UX Flow:**
1. User enters profile name (default: "default")
2. Backend calls `awsconfig.LoadDefaultConfig(ctx, awsconfig.WithSharedConfigProfile(name))`
3. SDK resolves credentials from the profile chain
4. Backend calls `sts:GetCallerIdentity` to validate and get account ID
5. Returns account as subscription item

**User provides:** Profile name (text input, pre-filled with "default")

**Implementation gap:** Scanner already handles `case "profile"`. Only `realAWSValidator` needs the profile validation path -- currently returns "Coming soon". Estimated: ~20 lines of Go.

**Confidence:** HIGH -- aws-sdk-go-v2 shared config loading is well-documented and already used in the scanner.

---

### 2. AWS Assume Role (Cross-Account)

**How it works:** User provides a Role ARN in the target account. The tool uses base credentials (access key or profile) to call `sts:AssumeRole`, receiving temporary credentials for the target account.

**UX Flow:**
1. User enters Role ARN (e.g., `arn:aws:iam::123456789012:role/ReadOnlyScanner`)
2. User optionally enters External ID (for cross-org roles)
3. User provides source credentials (access key ID + secret, or source profile name)
4. Backend builds base config from source creds, calls `sts:AssumeRole`
5. Returns target account ID as subscription item

**User provides:** Role ARN (required), External ID (optional), source access key or source profile

**Implementation gap:** Scanner already handles `case "assume_role"` and `case "assume-role"`. Validate handler returns "Coming soon". Frontend sends `roleArn`, `externalId`, `sourceProfile`. Need to wire up validate to: (a) build base config from `sourceProfile` or access key, (b) call `sts:AssumeRole`, (c) return target account. Estimated: ~40 lines of Go.

**Note:** Frontend currently has `sourceProfile` field but scanner's `buildConfig` for assume-role uses `access_key_id`/`secret_access_key` as base. Need to also support profile-based base creds for assume-role.

**Confidence:** HIGH -- STS AssumeRole is standard, already coded in scanner.

---

### 3. Azure Service Principal (Certificate)

**How it works:** Instead of a client secret, the service principal authenticates with an X.509 certificate. The private key signs a JWT assertion that Azure AD validates against the registered certificate.

**UX Flow:**
1. User enters Tenant ID, Client (App) ID
2. User enters path to PEM file (certificate + private key) or PFX file
3. Backend reads file from disk, parses certificate and key
4. Backend calls `azidentity.NewClientCertificateCredential(tenantID, clientID, certs, key, nil)`
5. Lists subscriptions to validate

**User provides:** Tenant ID, Client ID, certificate file path

**Implementation details:**
- PEM: `crypto/x509` + `encoding/pem` to parse cert chain and private key
- PFX/PKCS12: `golang.org/x/crypto/pkcs12` to decode -- but this may require CGO on some platforms. Check: `software.sslmate.com/src/go-pkcs12` is a pure-Go alternative.
- `azidentity.NewClientCertificateCredential` accepts `[]*x509.Certificate` and `crypto.PrivateKey`
- Session needs `CertPath` or parsed cert/key stored in memory

**Constraints:**
- Reading file from disk is a new pattern (all other auth is in-memory). File path must be accessible from the .exe's working directory.
- PFX files may have a password -- need an optional password field.
- Frontend currently shows `certPath` field. Consider adding optional `certPassword` for PFX.

**Confidence:** MEDIUM -- azidentity.NewClientCertificateCredential is documented, but PFX parsing without CGO needs verification.

---

### 4. Azure CLI (`az login`)

**How it works:** The `az` CLI stores tokens in `~/.azure/` after `az login`. `azidentity.NewAzureCLICredential` reads this token cache and uses the existing session.

**UX Flow:**
1. User selects "Azure CLI" -- no fields to fill in
2. Backend calls `azidentity.NewAzureCLICredential(nil)`
3. Lists subscriptions to validate
4. If `az` is not installed or user hasn't run `az login`, returns clear error

**User provides:** Nothing -- zero fields

**Implementation details:**
- `azidentity.NewAzureCLICredential` shells out to `az account get-access-token`
- Requires `az` CLI to be installed and on PATH
- Token is scoped -- may need to specify resource (`https://management.azure.com/.default`)
- Cache credential for scanner reuse (same pattern as browser-sso)
- On Windows: `az.cmd` is the executable name

**Constraints:**
- `az` CLI is an external dependency. Not "zero install" anymore, but acceptable for users who already have it.
- If `az` is not on PATH, must return a clear "install Azure CLI and run `az login` first" message.

**Confidence:** HIGH -- `azidentity.NewAzureCLICredential` is a standard azidentity credential type.

---

### 5. Azure Device Code Flow

**How it works:** Backend generates a device code and displays it to the user. User opens a URL on any device, enters the code, and authenticates. Backend polls until authentication completes.

**UX Flow:**
1. User enters Tenant ID
2. User clicks "Validate"
3. Backend starts device code flow, receives a user code + verification URL
4. **Backend must relay the code to the frontend** -- this is the key UX challenge
5. Frontend displays: "Go to https://microsoft.com/devicelogin and enter code: ABCD-EFGH"
6. User authenticates on their phone/another browser
7. Backend polls until token is received (or 15-minute timeout)
8. Returns subscription list

**User provides:** Tenant ID

**Implementation details:**
- `azidentity.NewDeviceCodeCredential` with a callback function that receives the device code message
- The callback is called synchronously during `GetToken()` -- need to relay the message to the HTTP response
- **Challenge:** The validate endpoint is a single POST request, but device code flow is async (user must authenticate externally, then backend polls)
- **Solution A:** Return the device code + URL in the validate response with `status: "pending_device_code"`, then frontend polls a status endpoint. More complex but cleaner.
- **Solution B:** Use the existing polling infrastructure. Validate returns immediately with the code. Frontend shows it. Frontend polls `/providers/azure/device-code-status` until auth completes.
- **Solution C:** Keep the HTTP request open (long-polling) while the device code flow completes. Simple backend, but frontend needs to handle the long wait without timeout.

**Recommendation:** Solution C (long-polling). The validate endpoint already blocks during AWS SSO (polls for 120s). Device code has a similar 15-min timeout. Frontend already handles slow validates (shows spinner). Add the device code message as a field in the validate response that the frontend can display while waiting.

**Actually:** Looking at the AWS SSO implementation, it opens the browser AND polls in the same validate call. Device code is similar but instead of opening a browser, it needs to relay the code. The simplest approach: use `azidentity.NewDeviceCodeCredential` with a callback that writes to a channel, and have the validate handler return the code first, then the frontend makes a second call that blocks until auth completes. OR: include the code in a specially-structured error response, have the frontend display it, and have the user click "validate" again after authenticating -- but this loses the polling.

**Best approach:** Modify the validate response to include an optional `deviceCode` + `verificationUrl` field. The validate endpoint starts the flow, immediately returns the code, and the frontend displays it. The frontend then calls a new `/providers/azure/device-code-poll` endpoint that blocks until the token is received. This keeps the existing validate pattern mostly intact.

**Confidence:** MEDIUM -- azidentity.NewDeviceCodeCredential is documented, but the UX relay pattern needs careful design.

---

### 6. GCP Browser OAuth

**How it works:** Similar to Azure browser-sso. Backend starts a localhost HTTP server, opens the browser to Google's OAuth2 consent screen, receives the auth code via redirect, exchanges it for tokens.

**UX Flow:**
1. User selects "Browser Login" -- no fields (or optional project ID)
2. Backend starts localhost callback server
3. Backend opens browser to Google OAuth2 URL with the well-known Cloud SDK client ID
4. User authenticates and consents
5. Callback receives auth code, exchanges for token
6. Backend lists accessible projects via Cloud Resource Manager
7. Returns project list as subscriptions

**User provides:** Nothing (browser opens automatically)

**Implementation details:**
- Use `golang.org/x/oauth2` with Google endpoints (`google.Endpoint`)
- Client ID: Cloud SDK public client (`764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com`)
- Client secret: `d-FL95Q19q7MQmFpd7hHD0Ty` (public client -- this is not a secret)
- Scopes: `compute.readonly`, `dns.readonly`, `cloudplatformprojects.readonly`
- Start `net.Listen("tcp", "127.0.0.1:0")` for dynamic port callback
- Redirect URI: `http://localhost:{port}`
- Open browser with `pkg/browser`
- Wait for callback, exchange code for token
- Cache TokenSource for scanner reuse (same pattern as ADC)
- Google's OAuth2 consent screen shows "Cloud SDK wants to access..." -- acceptable for a tool

**Constraints:**
- Google may block the Cloud SDK client ID for non-Google-distributed applications. If so, fall back to requiring users to provide their own OAuth2 client ID via a GCP project, which defeats the zero-config UX. Needs testing.
- Alternative: Use the "OOB" (out-of-band) flow where user copies a code back. But Google deprecated OOB in 2022.

**Confidence:** MEDIUM -- OAuth2 localhost redirect is well-understood, but using the Cloud SDK client ID from a third-party binary needs verification.

---

### 7. GCP Workload Identity Federation

**How it works:** A GCP workload identity pool trusts an external identity provider (AWS IAM, Azure AD, OIDC). The tool presents an external credential (e.g., AWS STS token), exchanges it for a GCP access token, then impersonates a service account.

**UX Flow:**
1. User enters project number, pool ID, provider ID, service account email
2. Backend constructs the WIF credential configuration JSON
3. Backend calls `google.CredentialsFromJSON` with the constructed config
4. Validates by listing projects
5. Returns project list

**User provides:** Project Number, Workload Identity Pool ID, Provider ID, Service Account Email

**Implementation details:**
- The WIF credential config JSON has this structure:
  ```json
  {
    "type": "external_account",
    "audience": "//iam.googleapis.com/projects/{project_number}/locations/global/workloadIdentityPools/{pool_id}/providers/{provider_id}",
    "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
    "service_account_impersonation_url": "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{sa_email}:generateAccessToken",
    "token_url": "https://sts.googleapis.com/v1/token",
    "credential_source": { ... }
  }
- The `credential_source` depends on the external provider (AWS uses IMDS/env, Azure uses managed identity endpoint, OIDC uses a file or URL)
- For a general-purpose tool, the simplest approach: accept a WIF credential config file path (user downloads from GCP Console) and pass it to `google.CredentialsFromJSON`
- Alternatively, construct the config from individual fields, but `credential_source` varies too much

**Recommendation:** Accept a WIF configuration file path (JSON). GCP Console provides a downloadable config file for each WIF provider. This is simpler than reconstructing the config from fields.

**Frontend change needed:** Replace the 4 individual fields with a single "Configuration File" path or paste area (like service account JSON).

**Confidence:** LOW -- WIF is complex with many provider-specific variations. The "accept config file" approach is safest but needs verification that `google.CredentialsFromJSON` handles external_account type correctly in this context.

---

### 8. AD Kerberos

**How it works:** Kerberos uses the current Windows domain user's TGT (ticket-granting ticket) from the Windows credential cache. No username/password needed. WinRM uses SPNEGO/Kerberos for message-level encryption.

**UX Flow:**
1. User enters server address(es) -- no username/password fields
2. Backend calls `winrm.NewEncryption("kerberos")` to create Kerberos transport
3. WinRM connects using the current user's Kerberos TGT
4. Validates with PowerShell probe

**User provides:** Server address(es) only

**Implementation details:**
- `masterzen/winrm` supports `winrm.NewEncryption("kerberos")` which uses `jcmturner/gokrb5`
- `jcmturner/gokrb5/v8` is already in go.mod (indirect dependency)
- gokrb5 is pure Go (CGO_ENABLED=0 compatible)
- **BUT:** gokrb5 does not read the Windows native Kerberos credential cache (SSPI). It needs:
  - A `krb5.conf` file (or DNS SRV record lookup for KDC discovery)
  - A keytab file OR username/password to obtain a TGT
  - It cannot access the Windows LSASS credential cache
- **This means:** True "current user" integrated auth (like .NET's `CredentialCache.DefaultCredentials`) is NOT possible with pure Go. SSPI requires CGO + `secur32.dll`.
- **Practical options:**
  a. Accept username/password and use gokrb5 to obtain a TGT, then authenticate via Kerberos (works, but defeats "no password" UX)
  b. Require a keytab file (enterprise admins can generate these, but adds complexity)
  c. Use CGO + SSPI on Windows only (violates CGO_ENABLED=0 constraint)
  d. Fall through to NTLM with clear messaging: "Kerberos integrated auth requires a domain-joined machine with SSPI support. Using NTLM instead."

**Recommendation:** Option (d) for v2.1. Detect `auth_method=kerberos` and return a clear error/warning explaining that pure-Go Kerberos cannot access Windows credential cache. Offer NTLM as fallback with username/password. Add `useKerberos` flag to AD credentials so if a future version adds CGO/SSPI support, it's ready.

**Alternative for v2.2+:** Build with CGO on Windows CI runner only. Use `github.com/alexbrainman/sspi` for SSPI integration. But this breaks the current cross-compile-from-Ubuntu CI pipeline.

**Confidence:** HIGH that pure-Go Kerberos cannot do Windows integrated auth. HIGH that NTLM fallback with clear messaging is the right v2.1 approach.

---

### 9. AD PowerShell Remoting (WinRM over HTTPS)

**How it works:** WinRM over HTTPS (port 5986) with TLS encryption at the transport level, plus NTLM message-level encryption. Same PowerShell commands, different transport.

**UX Flow:**
1. User enters server address(es), username, password
2. User toggles "Use HTTPS (port 5986)" checkbox
3. Backend creates WinRM endpoint with `useTLS: true, port: 5986`
4. Backend handles TLS certificate validation (self-signed certs common in enterprise)
5. Same PowerShell probe for validation

**User provides:** Server address(es), username, password, useSSL toggle

**Implementation details:**
- `winrm.NewEndpoint(host, 5986, true, insecure, caCert, cert, key, timeout)`
  - `useTLS=true` enables HTTPS
  - `insecure=true` skips certificate verification (needed for self-signed)
  - `caCert` can provide a custom CA certificate
- NTLM encryption still applies on top of TLS (belt-and-suspenders, standard Windows behavior)
- Frontend already has `useSSL` field in the PowerShell Remoting auth method
- Session needs `UseSSL bool` and `SkipTLS bool` fields in `ADCredentials`
- Scanner's `scanOneDC` needs to branch on auth method to use HTTPS endpoint

**Constraints:**
- Enterprise DCs commonly use self-signed certificates for WinRM HTTPS
- Need to surface "skip TLS verification" option (already pattern exists for Bluecat/EfficientIP)
- Port 5986 must be open in Windows Firewall (not always the case)

**Confidence:** HIGH -- winrm.NewEndpoint TLS support is documented and used by other Go WinRM tools.

## MVP Recommendation

Prioritize by impact/effort ratio and existing implementation status:

**Phase 1 -- Quick wins (already mostly implemented):**
1. AWS CLI Profile -- scanner done, just wire up validate (~20 lines)
2. AWS Assume Role -- scanner done, wire up validate + handle source profile (~40 lines)
3. Azure CLI -- `azidentity.NewAzureCLICredential`, zero UI fields (~30 lines)
4. AD PowerShell Remoting (HTTPS) -- winrm.NewEndpoint with TLS (~50 lines + session field)

**Phase 2 -- Medium effort:**
5. Azure Certificate -- file reading + cert parsing (~80 lines)
6. Azure Device Code -- needs UX design for code relay (~100 lines + frontend changes)
7. AD Kerberos -- clear error messaging + NTLM fallback (~30 lines)

**Phase 3 -- High effort, lower priority:**
8. GCP Browser OAuth -- localhost callback server (~150 lines, needs GCP client ID testing)
9. GCP Workload Identity -- config file approach (~80 lines, needs WIF testing)

**Defer:** Real Kerberos SSPI integration (requires CGO, breaks cross-compile)

## Sources

- Codebase analysis: `server/validate.go`, `internal/scanner/*/scanner.go`, `frontend/src/app/components/mock-data.ts`
- azure-sdk-for-go azidentity package: InteractiveBrowserCredential, DeviceCodeCredential, AzureCLICredential, ClientCertificateCredential (HIGH confidence, verified in go.mod dependency)
- aws-sdk-go-v2 config package: SharedConfigProfile, STS AssumeRole (HIGH confidence, already used in scanner)
- masterzen/winrm: NewEncryption("kerberos"), NewEndpoint TLS support (HIGH confidence, already a direct dependency)
- jcmturner/gokrb5/v8: Pure Go Kerberos, no SSPI support (HIGH confidence, verified as indirect dep in go.mod)
- golang.org/x/oauth2 + google endpoints: OAuth2 localhost redirect flow (MEDIUM confidence, standard pattern)
- GCP Workload Identity Federation: external_account credential type (LOW confidence, complex provider-specific variations)

# Pitfalls Research

**Domain:** Auth method completion for Go+React cloud scanner (9 auth methods across AWS, Azure, GCP, AD)
**Researched:** 2026-03-14
**Confidence:** HIGH (verified against existing codebase, SDK docs, and known issues)

## Critical Pitfalls

### Pitfall 1: Azure PFX/PKCS12 SHA256 Digest Failure (Certificate Auth)

**What goes wrong:**
`azidentity.ParseCertificates()` cannot parse PFX files that use SHA256 for message authentication (MAC). The standard `golang.org/x/crypto/pkcs12` package is frozen and only supports SHA1 MAC. When a customer provides a modern PFX file (exported from Azure Portal or modern OpenSSL), parsing fails with `pkcs12: unknown digest algorithm: 2.16.840.1.101.3.4.2.1`.

**Why it happens:**
Azure Portal and modern certificate tools default to SHA256 MAC for PFX export. The Go standard library's pkcs12 package only supports SHA1 MAC. The azidentity SDK delegates to this frozen stdlib package. This is a [known issue](https://github.com/Azure/azure-sdk-for-go/issues/22906).

**How to avoid:**
Accept both PEM and PFX formats. For PFX, attempt `azidentity.ParseCertificates()` first. If it fails with the digest algorithm error, fall back to `software.sslmate.com/src/go-pkcs12` which handles SHA256 MAC. Both are pure Go, CGO_ENABLED=0 compatible. Alternatively, document that PEM format is preferred and provide conversion instructions in the error message.

**Warning signs:**
Works with test certificates but fails with real customer certificates. The customer says "I exported this from Azure Portal."

**Phase to address:**
Azure auth methods phase. Must be tested with a real SHA256-MAC PFX file, not just PEM or legacy PFX.

---

### Pitfall 2: AD Kerberos Requires krb5.conf and KDC Discovery (Not Just Username/Password)

**What goes wrong:**
Developers assume Kerberos auth is "like NTLM but with a different transport decorator." In reality, Kerberos requires: (1) a KDC address or DNS SRV record resolution, (2) a Kerberos realm, and (3) optionally a keytab. The masterzen/winrm library's Kerberos support uses `jcmturner/gokrb5` which needs a `krb5.conf`-style configuration or explicit KDC/realm parameters.

**Why it happens:**
NTLM is point-to-point (client talks directly to DC). Kerberos is a three-party protocol (client talks to KDC, then DC). Developers familiar with NTLM miss the KDC discovery step entirely.

**How to avoid:**
The frontend must collect additional fields for Kerberos: realm (e.g., `CORP.EXAMPLE.COM`) and optionally KDC address (defaults to DNS SRV `_kerberos._tcp.{realm}`). Build a minimal in-memory krb5.conf programmatically from these fields. The `jcmturner/gokrb5/v8` library is pure Go (CGO_ENABLED=0 compatible) -- do NOT use `ubccr/kerby` which wraps GSSAPI and requires CGO.

**Warning signs:**
Auth works in development (where the dev machine is domain-joined) but fails when the customer runs the .exe on a non-domain-joined laptop. This is the primary use case for this tool.

**Phase to address:**
AD auth methods phase. Critical to test from a non-domain-joined machine. The existing MEMORY.md already flags this: "Kerberos requires domain-joined client machine."

---

### Pitfall 3: STS AssumeRole Token Expiry During Long Scans (AWS)

**What goes wrong:**
`sts.AssumeRole` returns temporary credentials that default to 1 hour. The current implementation (line 182 of aws/scanner.go) calls AssumeRole once and uses static credentials for the entire scan. For large AWS environments with many regions, a scan can take 30+ minutes. If the scan takes longer than the token lifetime, API calls fail partway through with `ExpiredTokenException`.

**Why it happens:**
The current code converts AssumeRole output directly to `StaticCredentialsProvider`. This freezes the credentials at the point of issuance with no refresh mechanism.

**How to avoid:**
Use `stscreds.NewAssumeRoleProvider` with `aws.NewCredentialsCache()` instead of calling `sts.AssumeRole` directly and extracting static credentials. The provider automatically refreshes before expiry. Set `ExpiryWindow` to 5 minutes to ensure proactive refresh.

```go
provider := stscreds.NewAssumeRoleProvider(stsClient, roleArn, func(o *stscreds.AssumeRoleOptions) {
    o.RoleSessionName = "uddi-go-token-calculator"
})
cfg.Credentials = aws.NewCredentialsCache(provider, func(o *aws.CredentialsCacheOptions) {
    o.ExpiryWindow = 5 * time.Minute
})
```

**Warning signs:**
Small AWS accounts scan fine. Large accounts (20+ regions, many VPCs) fail midway with auth errors.

**Phase to address:**
AWS auth methods phase. The existing `buildConfig` for assume_role needs to be refactored.

---

### Pitfall 4: Validate-then-Scan Credential Mismatch Pattern

**What goes wrong:**
The current architecture has a two-step flow: validate (returns subscriptions) then scan (uses stored credentials). For auth methods that produce short-lived tokens (AWS AssumeRole, Azure Device Code, GCP Browser OAuth), the token obtained during validation may expire before the scan starts -- especially if the user takes time selecting subscriptions/projects in the UI.

**Why it happens:**
The existing SSO implementations (AWS SSO, Azure Browser SSO) already handle this via credential caching (azureCredCache, gcpTokenCache). But new auth methods may not follow this pattern, or developers may cache a static token instead of a refreshable credential.

**How to avoid:**
Every auth method that produces short-lived tokens must cache a refreshable credential object (TokenCredential, TokenSource, CredentialsProvider), not a static token string. Follow the existing pattern in `storeCredentials()` which stores `azcore.TokenCredential` and `oauth2.TokenSource` objects. For AWS AssumeRole, store an `AssumeRoleProvider` in the session, not static STS output.

**Warning signs:**
Validation succeeds but scan fails with "token expired" or "unauthorized" after the user spends time in the subscription selection step.

**Phase to address:**
All phases. Each auth method implementation must be reviewed against this pattern during code review.

---

### Pitfall 5: GCP Browser OAuth Redirect Port Collision with App Server

**What goes wrong:**
The application already binds to a localhost port (typically :0, auto-assigned). GCP OAuth2 authorization code flow requires a localhost redirect URI. If the OAuth redirect listener tries to bind to a specific port that is already in use, or if the OAuth client ID's authorized redirect URIs don't match the dynamically chosen port, the OAuth flow fails.

**Why it happens:**
GCP OAuth2 requires pre-registered redirect URIs in the Google Cloud Console. Unlike Azure's `InteractiveBrowserCredential` (which handles redirect internally), GCP's `golang.org/x/oauth2` package requires the developer to manage the redirect server.

**How to avoid:**
Use a fixed loopback port for the OAuth callback (e.g., `http://127.0.0.1:18923/callback`) that is different from the main app server port. Register this exact URI in the GCP OAuth client configuration. The GCP OAuth client ID must be bundled with the application (public client, no secret). Alternatively, use device code flow instead of authorization code flow -- it avoids redirect entirely and mirrors the existing AWS SSO pattern.

**Warning signs:**
OAuth works on the developer's machine but fails on the customer's machine because a different process occupies the redirect port.

**Phase to address:**
GCP auth methods phase. Architecture decision needed: authorization code flow vs. device code flow.

---

### Pitfall 6: Azure AzureCLICredential Invokes `az` Binary (Not Available on Customer Machines)

**What goes wrong:**
`azidentity.NewAzureCLICredential()` shells out to the `az` CLI binary on every token request. The tool's target user (pre-sales engineer handing a .exe to a customer) operates on machines that do not have Azure CLI installed.

**Why it happens:**
Developers test with `az login` on their own machines where Azure CLI is installed. The auth method "works" in development but is fundamentally incompatible with the tool's distribution model (single .exe, no dependencies).

**How to avoid:**
This auth method must be explicitly documented as "requires Azure CLI to be installed and authenticated" in the UI. Add a pre-flight check: verify `az` is on PATH before attempting authentication. Return a clear error: "Azure CLI not found. Install from https://aka.ms/installazurecli and run 'az login' first." Consider whether this auth method is worth implementing at all given the target use case -- it may be better to show a clear "Not available: requires Azure CLI" message with a link.

**Warning signs:**
No warning signs in development -- it always works for developers. Fails 100% on customer machines.

**Phase to address:**
Azure auth methods phase. Product decision: implement with clear prereq messaging, or replace with a more self-contained alternative.

---

### Pitfall 7: AD PowerShell Remoting HTTPS (Port 5986) Self-Signed Certificate Rejection

**What goes wrong:**
WinRM over HTTPS (port 5986) uses TLS. Most enterprise DCs use self-signed or internal CA certificates for WinRM HTTPS. The Go `crypto/tls` default behavior rejects these certificates, causing connection failure.

**Why it happens:**
The current NTLM implementation (port 5985, HTTP) does not use TLS at all -- message-level encryption handles security. When switching to HTTPS (port 5986), TLS certificate validation kicks in, and self-signed certs fail verification.

**How to avoid:**
Add a "Skip TLS verification" checkbox for AD connections (matching the existing Bluecat/EfficientIP/NIOS pattern). When constructing the WinRM endpoint for HTTPS, set `insecure: true` and pass the CA cert bundle or skip verification based on user preference. The `winrm.NewEndpoint()` already accepts `insecure bool` and `caCert []byte` parameters.

```go
endpoint := winrm.NewEndpoint(host, 5986, true /* useHTTPS */, skipTLS, nil, nil, nil, winrmTimeout)
```

**Warning signs:**
Works against DCs with proper CA-signed certificates but fails against the majority of enterprise DCs that use self-signed WinRM certs.

**Phase to address:**
AD auth methods phase. UI needs a "Use HTTPS (port 5986)" toggle plus "Skip TLS verification" checkbox.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Static credentials instead of refreshable provider (AssumeRole) | Simpler code, matches existing access_key pattern | Token expiry for long scans | Never -- use CredentialsCache |
| Hardcoding OAuth redirect port | No dynamic port management | Port conflicts on customer machines | Only if port is unusual (e.g., 18923) and documented |
| Skipping PFX SHA256 fallback | Less code, one parsing path | Fails with modern Azure-exported PFX files | Never -- customers always have SHA256 PFX |
| Bundling GCP OAuth client ID in binary | Required for OAuth flow | Client ID is technically extractable from binary | Acceptable -- public client IDs are not secrets |
| Implementing az-cli auth for a standalone .exe | Feature completeness | Users expect it to work without Azure CLI installed | Acceptable if clearly labeled with prerequisites |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| AWS SharedConfigProfile | Reading `~/.aws/credentials` -- path resolution fails on Windows service accounts or when `%USERPROFILE%` is not set | Use `awsconfig.WithSharedConfigProfile(name)` which handles OS-specific path resolution internally via `os.UserHomeDir()` |
| AWS AssumeRole cross-account | Forgetting ExternalId for cross-account trust policies | Accept optional `externalId` field in the UI; pass it to `AssumeRoleInput.ExternalId` |
| Azure DeviceCodeCredential | Not surfacing the device code + URL to the user in the web UI | The SDK provides a callback `DeviceCodeCredentialOptions.UserPrompt` -- use it to send the code/URL back to the frontend via SSE or polling response |
| Azure Certificate auth | Using `azidentity.ParseCertificates()` without handling the SHA256 MAC error | Try ParseCertificates, catch digest algorithm error, fall back to sslmate/go-pkcs12 |
| GCP Workload Identity Federation | Expecting the user to paste a JSON config string | Accept a file upload or text paste of the credential configuration JSON generated by `gcloud iam workload-identity-pools create-cred-config` |
| GCP Browser OAuth | Not setting `access_type=offline` in the authorization request | Without offline access, no refresh token is returned and the credential expires after 1 hour |
| AD Kerberos via WinRM | Using `winrm.NewEncryption("kerberos")` without providing KDC/realm config | Must construct a `gokrb5` client with explicit realm and KDC, then pass it to the WinRM Kerberos transport |
| AD PowerShell HTTPS | Hardcoding port 5985 (current code) | Check `useSSL` flag and switch between port 5985 (HTTP) and 5986 (HTTPS) |
| Azure AzureCLICredential | Assuming `az` binary exists | Pre-check: `exec.LookPath("az")` before attempting credential creation |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| AzureCLICredential shelling out per-request | Every Azure API call spawns `az account get-access-token` subprocess | Cache the token with manual TTL or use a different credential type | Any scan with > 10 API calls (i.e., always) |
| Kerberos TGT not cached across DC connections | Multi-DC scan obtains a new TGT for each DC instead of reusing | Create one gokrb5 client, reuse across all DCs | Multi-DC environments (the normal case) |
| GCP OAuth token not set to auto-refresh | Manual token fetch expires after 1 hour, scan fails midway | Use `oauth2.ReuseTokenSource` with the initial token | Large GCP environments with many projects |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Bundling GCP OAuth client secret in binary | Client secret extractable via binary analysis | Use "Desktop app" OAuth client type (public client, no secret needed) |
| Logging credential validation errors with credential values | Credential leakage in error messages | Sanitize error messages -- never include accessKeyId, clientSecret, password in error strings |
| Storing PFX password in session alongside certificate | Password persists in memory longer than necessary | Parse the certificate during validation, store only the parsed cert/key pair, discard the password |
| Kerberos keytab file read from user-specified path | Path traversal if user provides `../../../../etc/shadow` | Validate path, or better: accept keytab as file upload content (base64), not a file path |
| az-cli credential inheriting developer's ambient auth | Tool uses the wrong Azure identity during testing | This is why the project explicitly prohibits DefaultAzureCredential -- extend this principle to az-cli by requiring explicit tenant selection |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Azure Device Code: showing code in a modal that blocks the app | User cannot copy the code because the modal prevents interaction | Show code inline in the credential form with a "Copy" button; keep the form interactive while polling |
| Kerberos: asking for krb5.conf file path | Pre-sales engineers do not know what krb5.conf is | Ask for "Kerberos Realm" (text field, e.g., CORP.EXAMPLE.COM) and "KDC Server" (optional, defaults to DNS SRV) |
| GCP OAuth: browser popup with no explanation | User sees a Google login popup with no context | Show "Opening Google sign-in..." message with a manual fallback link |
| AWS Profile: showing a text field for profile name | User does not know their profile names | Read `~/.aws/config` and show a dropdown of available profiles (if the file exists) |
| PowerShell HTTPS: failing silently when port 5986 is not configured on DC | User sees "connection refused" with no explanation | Detect connection refused on 5986 and suggest: "WinRM HTTPS may not be configured. Try unchecking 'Use HTTPS' to use port 5985 instead." |
| Auth method selection: too many choices | Pre-sales engineer is overwhelmed by 4+ auth options per provider | Default to the simplest method (access key, service principal, NTLM) and group advanced methods under "Advanced" |

## "Looks Done But Isn't" Checklist

- [ ] **AWS Profile:** Works on developer machine but fails on customer machine without `~/.aws/config` -- verify behavior when the file does not exist (clear error, not crash)
- [ ] **AWS AssumeRole:** Works for short scans but credential expires on large environments -- test with a 15-minute token against a multi-region account
- [ ] **Azure Certificate:** Works with PEM test cert but fails with customer's PFX export -- test with a PFX exported from Azure Portal (SHA256 MAC)
- [ ] **Azure az-cli:** Works on dev machine but requires Azure CLI installed -- verify error message when `az` is not on PATH
- [ ] **Azure Device Code:** Polling works but code display is missing or not copyable -- verify the full UX flow end-to-end including code display, copy, and timeout handling
- [ ] **GCP Browser OAuth:** OAuth redirect works but token is not refreshable -- verify scan completion with a token that expires mid-scan
- [ ] **GCP Workload Identity:** Config file parses but the external token source is not reachable from customer network -- verify error messages for unreachable token endpoints
- [ ] **AD Kerberos:** Auth works from domain-joined dev machine but fails from standalone laptop -- test from a non-domain-joined Windows machine
- [ ] **AD PowerShell HTTPS:** TLS handshake succeeds with proper CA cert but fails with self-signed -- test with a self-signed WinRM HTTPS certificate
- [ ] **Session clone (re-scan):** All 9 new auth methods preserve credentials correctly during session clone -- verify cloneSession() handles new credential types

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| PFX SHA256 parsing failure | LOW | Add sslmate/go-pkcs12 fallback; no API change needed |
| STS token expiry mid-scan | MEDIUM | Refactor buildConfig to use AssumeRoleProvider instead of static creds; requires testing |
| KDC discovery failure (Kerberos) | LOW | Add explicit KDC field to UI; no backend architecture change |
| OAuth redirect port collision | MEDIUM | Switch to device code flow; requires UI changes and a different OAuth client type |
| az-cli not found | LOW | Add `exec.LookPath("az")` pre-check; return clear error message |
| Self-signed WinRM cert rejection | LOW | Add skipTLS parameter to endpoint constructor; existing pattern in codebase |
| Device Code timeout with no feedback | LOW | Use DeviceCodeCredentialOptions.UserPrompt callback; surface via polling API |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| PFX SHA256 digest failure | Azure auth methods | Test with Azure Portal-exported PFX file |
| Kerberos KDC/realm requirement | AD auth methods | Test from non-domain-joined Windows machine |
| STS token expiry | AWS auth methods | Test AssumeRole scan on 20+ region account |
| Validate-scan credential gap | All auth phases | Time-delay test: validate, wait 20 min, then scan |
| OAuth redirect port collision | GCP auth methods | Test with main app on various ports |
| az-cli binary dependency | Azure auth methods | Test on clean Windows without Azure CLI |
| WinRM HTTPS self-signed cert | AD auth methods | Test against DC with self-signed WinRM cert |
| Device Code UX | Azure auth methods | End-to-end UX test: code display, copy, approval, polling |
| GCP OAuth token refresh | GCP auth methods | Test scan with 1-hour expiry token on large project |
| Session clone for new auth types | Final integration phase | Clone + re-scan test for each of the 9 auth methods |

## Sources

- [azidentity ParseCertificates PKCS12 SHA256 issue](https://github.com/Azure/azure-sdk-for-go/issues/22906)
- [azidentity package documentation](https://pkg.go.dev/github.com/Azure/azure-sdk-for-go/sdk/azidentity)
- [masterzen/winrm Kerberos support](https://github.com/masterzen/winrm)
- [jcmturner/gokrb5 pure Go Kerberos](https://github.com/jcmturner/gokrb5)
- [aws-sdk-go-v2 stscreds AssumeRoleProvider](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/credentials/stscreds)
- [AWS STS AssumeRole token expiration strategies](https://medium.com/@dd_de_b/aws-sts-assumerole-in-go-441712307491)
- [GCP externalaccount (Workload Identity Federation)](https://pkg.go.dev/golang.org/x/oauth2/google/externalaccount)
- [GCP Workload Identity Federation docs](https://cloud.google.com/iam/docs/workload-identity-federation)
- [WinRM HTTPS configuration](https://learn.microsoft.com/en-us/troubleshoot/windows-client/system-management-components/configure-winrm-for-https)
- [sslmate/go-pkcs12 (SHA256 PFX support)](https://pkg.go.dev/software.sslmate.com/src/go-pkcs12)
- [aws-sdk-go-v2 shared config](https://pkg.go.dev/github.com/aws/aws-sdk-go-v2/config)
- Existing codebase: `server/validate.go`, `internal/scanner/aws/scanner.go`, `internal/scanner/azure/scanner.go`, `internal/scanner/gcp/scanner.go`, `internal/scanner/ad/scanner.go`

---
*Pitfalls research for: Auth method completion (9 methods) in UDDI-GO Token Calculator*
*Researched: 2026-03-14*