# T02: 15-quick-win-auth-methods 01

**Slice:** S01 — **Milestone:** M003

## Description

Implement AWS CLI Profile and AWS Assume Role authentication -- two auth methods that currently return "Coming soon" in the validator.

Purpose: AWS users can authenticate with named CLI profiles (including SSO profiles) and assume cross-account roles with auto-refreshing credentials that survive long multi-region scans.

Output: Working profile and assume-role cases in validator, auto-refreshing assume-role in scanner, session/orchestrator field mappings.

## Must-Haves

- [ ] "User selects AWS CLI Profile, clicks validate, and backend authenticates using the named profile from ~/.aws/credentials"
- [ ] "User enters a Role ARN and optional external ID, clicks validate, and backend assumes the role via STS returning the target account ID"
- [ ] "AWS Assume Role credentials auto-refresh during long multi-region scans (no ExpiredTokenException after 1 hour)"
- [ ] "Empty profile name defaults to 'default' matching AWS CLI convention"
- [ ] "Empty sourceProfile defaults to 'default' for assume-role base credentials"
- [ ] "Empty ExternalId is omitted from STS call (not sent as empty string)"

## Files

- `server/validate.go`
- `internal/scanner/aws/scanner.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
