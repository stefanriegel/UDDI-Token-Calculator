# T01: 13-fix-bluecat-efficientip-credential-wiring 01

**Slice:** S05 — **Milestone:** M002

## Description

Fix credential key name mismatches in server/validate.go so Bluecat, EfficientIP, and NIOS WAPI E2E flows work.

Purpose: The frontend sends provider-prefixed keys (bluecat_url, efficientip_url, wapi_url) and snake_case fields (skip_tls, configuration_ids, site_ids), but storeCredentials() and the three validators read unprefixed/camelCase keys, resulting in empty credential storage and broken scan flows.

Output: Updated validate.go with 6 corrected touch points + validate_test.go with tests proving prefixed keys are stored correctly.

## Must-Haves

- [ ] "storeCredentials reads bluecat_url/bluecat_username/bluecat_password from creds map (not url/username/password)"
- [ ] "storeCredentials reads efficientip_url/efficientip_username/efficientip_password from creds map"
- [ ] "storeCredentials reads wapi_url/wapi_username/wapi_password for NIOS WAPI mode"
- [ ] "All three providers read skip_tls (not skipTls) for TLS toggle"
- [ ] "Bluecat reads configuration_ids (not configurationIds) for advanced filter"
- [ ] "EfficientIP reads site_ids (not siteIds) for advanced filter"
- [ ] "Validators read prefixed keys matching what the frontend sends"

## Files

- `server/validate.go`
- `server/validate_test.go`
