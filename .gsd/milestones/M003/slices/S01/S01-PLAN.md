# S01: Quick Win Auth Methods

**Goal:** Create failing test stubs (Wave 0 / Nyquist compliance) for the 5 new auth method behaviors that plans 15-01 and 15-02 will implement.
**Demo:** Create failing test stubs (Wave 0 / Nyquist compliance) for the 5 new auth method behaviors that plans 15-01 and 15-02 will implement.

## Must-Haves


## Tasks

- [x] **T01: 15-quick-win-auth-methods 00** `est:3min`
  - Create failing test stubs (Wave 0 / Nyquist compliance) for the 5 new auth method behaviors that plans 15-01 and 15-02 will implement.

Purpose: Tests exist before implementation so that plan executors can use them as verification targets. Each test fails with a clear message indicating the behavior is not yet implemented ("Coming soon" or missing feature).

Output: 5 failing test functions across 3 test files. All tests compile against the current codebase.
- [x] **T02: 15-quick-win-auth-methods 01** `est:4min`
  - Implement AWS CLI Profile and AWS Assume Role authentication -- two auth methods that currently return "Coming soon" in the validator.

Purpose: AWS users can authenticate with named CLI profiles (including SSO profiles) and assume cross-account roles with auto-refreshing credentials that survive long multi-region scans.

Output: Working profile and assume-role cases in validator, auto-refreshing assume-role in scanner, session/orchestrator field mappings.
- [x] **T03: 15-quick-win-auth-methods 02** `est:4min`
  - Implement Azure CLI authentication and AD WinRM over HTTPS -- two auth methods that currently return "Coming soon" or silently ignore the useSSL toggle.

Purpose: Azure users with existing `az login` sessions get zero-field authentication. AD users in hardened environments can connect over HTTPS (port 5986) with TLS, including self-signed certificate support.

Output: Working az-cli validator with credential caching, az-cli scanner case, BuildNTLMClient HTTPS support with options pattern, session/orchestrator field mappings, frontend insecureSkipVerify field.

## Files Likely Touched

- `server/validate_test.go`
- `internal/scanner/aws/scanner_test.go`
- `internal/scanner/ad/scanner_test.go`
- `server/validate.go`
- `internal/scanner/aws/scanner.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
- `server/validate.go`
- `internal/scanner/azure/scanner.go`
- `internal/scanner/ad/scanner.go`
- `internal/scanner/ad/scanner_test.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
- `frontend/src/app/components/mock-data.ts`
