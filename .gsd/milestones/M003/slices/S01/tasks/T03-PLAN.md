# T03: 15-quick-win-auth-methods 02

**Slice:** S01 — **Milestone:** M003

## Description

Implement Azure CLI authentication and AD WinRM over HTTPS -- two auth methods that currently return "Coming soon" or silently ignore the useSSL toggle.

Purpose: Azure users with existing `az login` sessions get zero-field authentication. AD users in hardened environments can connect over HTTPS (port 5986) with TLS, including self-signed certificate support.

Output: Working az-cli validator with credential caching, az-cli scanner case, BuildNTLMClient HTTPS support with options pattern, session/orchestrator field mappings, frontend insecureSkipVerify field.

## Must-Haves

- [ ] "User selects Azure CLI auth, clicks validate, and backend authenticates using existing az login session"
- [ ] "If az binary is not installed, user sees clear error with install URL (https://aka.ms/installazurecli)"
- [ ] "If az is installed but session expired, user sees actionable error telling them to run 'az login'"
- [ ] "Azure CLI credential is cached and reused by scanner (no second az command during scan)"
- [ ] "User selects AD PowerShell Remoting, toggles Use HTTPS, and backend connects via WinRM port 5986 with TLS"
- [ ] "User can toggle 'Allow untrusted certificates' for self-signed WinRM HTTPS endpoints"
- [ ] "HTTPS transport skips SPNEGO message-level encryption (TLS provides transport security)"

## Files

- `server/validate.go`
- `internal/scanner/azure/scanner.go`
- `internal/scanner/ad/scanner.go`
- `internal/scanner/ad/scanner_test.go`
- `internal/session/session.go`
- `internal/orchestrator/orchestrator.go`
- `frontend/src/app/components/mock-data.ts`
