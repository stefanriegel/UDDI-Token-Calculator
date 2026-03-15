# S05: Fix Bluecat Efficientip Credential Wiring

**Goal:** Fix credential key name mismatches in server/validate.
**Demo:** Fix credential key name mismatches in server/validate.

## Must-Haves


## Tasks

- [x] **T01: 13-fix-bluecat-efficientip-credential-wiring 01** `est:2min`
  - Fix credential key name mismatches in server/validate.go so Bluecat, EfficientIP, and NIOS WAPI E2E flows work.

Purpose: The frontend sends provider-prefixed keys (bluecat_url, efficientip_url, wapi_url) and snake_case fields (skip_tls, configuration_ids, site_ids), but storeCredentials() and the three validators read unprefixed/camelCase keys, resulting in empty credential storage and broken scan flows.

Output: Updated validate.go with 6 corrected touch points + validate_test.go with tests proving prefixed keys are stored correctly.

## Files Likely Touched

- `server/validate.go`
- `server/validate_test.go`
