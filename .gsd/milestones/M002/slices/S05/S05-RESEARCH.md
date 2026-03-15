# Phase 13: Fix Bluecat/EfficientIP Credential Wiring - Research

**Researched:** 2026-03-13
**Domain:** Backend credential key mapping (Go, server/validate.go)
**Confidence:** HIGH

## Summary

The frontend sends provider-prefixed credential keys (`bluecat_url`, `efficientip_url`, `wapi_url`, etc.) and snake_case field names (`skip_tls`, `configuration_ids`, `site_ids`), but `storeCredentials()` and the three new validators (`realBluecatValidator`, `realEfficientIPValidator`, `realNiosWAPIValidator`) read unprefixed/camelCase keys (`url`, `username`, `password`, `skipTls`, `configurationIds`, `siteIds`). This causes all three providers' credentials to be stored as empty strings in the session, breaking the E2E flow.

The orchestrator and scanners are already correct -- they use prefixed keys (`bluecat_url`, `efficientip_url`, `wapi_url`, etc.) and snake_case (`skip_tls`, `configuration_ids`, `site_ids`). The break is isolated to `storeCredentials()` (3 switch cases) and the 3 validator functions, all in `server/validate.go`.

**Primary recommendation:** Update the 6 touch points in `server/validate.go` to read the prefixed/snake_case keys the frontend sends, then update `server/validate_test.go` to use prefixed keys in test assertions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Fix in the backend -- `storeCredentials()` and all three validators updated to read prefixed keys
- Frontend stays unchanged -- prefixed keys (`bluecat_url`, `efficientip_url`, `nios_url`) are more explicit and prevent collisions
- NIOS WAPI also aligned to prefixed keys (`nios_url`, `nios_username`, `nios_password`) for consistency, even though it was partially working
- Backend reads `bluecat_url`, `bluecat_username`, `bluecat_password` (not `url`, `username`, `password`)
- Backend reads `efficientip_url`, `efficientip_username`, `efficientip_password` (not `url`, `username`, `password`)
- Backend reads `nios_url`, `nios_username`, `nios_password` for WAPI mode
- Backend reads `skip_tls` (snake_case, not `skipTls`) for all three providers
- Backend reads `configuration_ids` (not `configurationIds`) for Bluecat advanced filter
- Backend reads `site_ids` (not `siteIds`) for EfficientIP advanced filter
- Hardcoded advanced sections in wizard.tsx left as-is -- not moved to mock-data.ts credential fields
- This is a bug fix, not a refactor
- Update existing validate_test.go tests to use prefixed keys (replace old unprefixed key tests)
- No separate storeCredentials unit tests -- validate handler tests cover the full path
- No integration mock server -- unit tests are sufficient for this key-mapping fix

### Claude's Discretion
- Exact test case structure and assertion style (follow existing validate_test.go patterns)
- Whether to add helper function for key prefix stripping or just update each case directly

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| BC-02 | Bluecat scanner counts DNS/IPAM/DHCP with optional config ID filtering | storeCredentials must correctly store bluecat_url/username/password + configuration_ids so orchestrator can forward to scanner |
| EIP-02 | EfficientIP scanner counts DNS/IPAM/DHCP with optional site ID filtering | storeCredentials must correctly store efficientip_url/username/password + site_ids so orchestrator can forward to scanner |
| FE-09 | Bluecat provider card with credential form, TLS skip, advanced section | Frontend already sends correct prefixed keys; backend must match |
| FE-10 | EfficientIP provider card with credential form, TLS skip, advanced section | Frontend already sends correct prefixed keys; backend must match |
</phase_requirements>

## Architecture Patterns

### The Credential Flow (E2E)

```
Frontend (wizard.tsx)
  credentials[provId] = { bluecat_url: "...", bluecat_username: "...", ... skip_tls: "true", configuration_ids: "42" }
       |
       v
  api-client.ts: validateBluecat(creds)
  POST /api/v1/providers/bluecat/validate  { authMethod: "credentials", credentials: {...} }
       |
       v
  server/validate.go: HandleValidate
    -> merged = req.Credentials + authMethod
    -> realBluecatValidator(ctx, merged)          <-- BUG: reads creds["url"] not creds["bluecat_url"]
    -> storeCredentials(sess, "bluecat", merged)  <-- BUG: reads creds["url"] not creds["bluecat_url"]
       |
       v
  session.BluecatCredentials { URL: "", Username: "", Password: "" }  <-- EMPTY!
       |
       v
  orchestrator.go: sess.Bluecat.URL -> ""  <-- forwards empty creds to scanner
```

### Exact Key Mismatches (6 touch points)

#### 1. `storeCredentials` case "bluecat" (line ~275-290)
| Current (WRONG) | Frontend sends | Fix to |
|-----------------|---------------|--------|
| `creds["url"]` | `bluecat_url` | `creds["bluecat_url"]` |
| `creds["username"]` | `bluecat_username` | `creds["bluecat_username"]` |
| `creds["password"]` | `bluecat_password` | `creds["bluecat_password"]` |
| `creds["skipTls"]` | `skip_tls` | `creds["skip_tls"]` |
| `creds["configurationIds"]` | `configuration_ids` | `creds["configuration_ids"]` |

#### 2. `storeCredentials` case "efficientip" (line ~291-306)
| Current (WRONG) | Frontend sends | Fix to |
|-----------------|---------------|--------|
| `creds["url"]` | `efficientip_url` | `creds["efficientip_url"]` |
| `creds["username"]` | `efficientip_username` | `creds["efficientip_username"]` |
| `creds["password"]` | `efficientip_password` | `creds["efficientip_password"]` |
| `creds["skipTls"]` | `skip_tls` | `creds["skip_tls"]` |
| `creds["siteIds"]` | `site_ids` | `creds["site_ids"]` |

#### 3. `storeCredentials` case "nios" (line ~307-319)
| Current (WRONG) | Frontend sends | Fix to |
|-----------------|---------------|--------|
| `creds["url"]` | `wapi_url` | `creds["wapi_url"]` |
| `creds["username"]` | `wapi_username` | `creds["wapi_username"]` |
| `creds["password"]` | `wapi_password` | `creds["wapi_password"]` |
| `creds["skipTls"]` | `skip_tls` | `creds["skip_tls"]` |
| `creds["wapiVersion"]` | `wapi_version` | `creds["wapi_version"]` |

#### 4. `realBluecatValidator` (line ~835-883)
| Current (WRONG) | Frontend sends | Fix to |
|-----------------|---------------|--------|
| `creds["url"]` | `bluecat_url` | `creds["bluecat_url"]` |
| `creds["username"]` | `bluecat_username` | `creds["bluecat_username"]` |
| `creds["password"]` | `bluecat_password` | `creds["bluecat_password"]` |
| `creds["skipTls"]` | `skip_tls` | `creds["skip_tls"]` |

#### 5. `realEfficientIPValidator` (line ~888-938)
| Current (WRONG) | Frontend sends | Fix to |
|-----------------|---------------|--------|
| `creds["url"]` | `efficientip_url` | `creds["efficientip_url"]` |
| `creds["username"]` | `efficientip_username` | `creds["efficientip_username"]` |
| `creds["password"]` | `efficientip_password` | `creds["efficientip_password"]` |
| `creds["skipTls"]` | `skip_tls` | `creds["skip_tls"]` |

#### 6. `realNiosWAPIValidator` (line ~943-1053)
| Current (WRONG) | Frontend sends | Fix to |
|-----------------|---------------|--------|
| `creds["url"]` | `wapi_url` | `creds["wapi_url"]` |
| `creds["username"]` | `wapi_username` | `creds["wapi_username"]` |
| `creds["password"]` | `wapi_password` | `creds["wapi_password"]` |
| `creds["skipTls"]` | `skip_tls` | `creds["skip_tls"]` |
| `creds["wapiVersion"]` | `wapi_version` | `creds["wapi_version"]` |

### CONTEXT.md Correction: NIOS WAPI Keys

The CONTEXT.md states the keys should be `nios_url`, `nios_username`, `nios_password`. However, the actual frontend mock-data.ts (line 277-280) uses `wapi_url`, `wapi_username`, `wapi_password`, `wapi_version`. The orchestrator (line 258-261) also uses `wapi_url`, `wapi_username`, `wapi_password`, `wapi_version` when forwarding to the scanner. The scanner itself reads `wapi_url`, `wapi_username`, `wapi_password`.

**The correct fix is `wapi_` prefix, not `nios_` prefix.** The entire downstream pipeline (orchestrator + scanner + scanner tests) already consistently uses `wapi_` prefix. The CONTEXT.md decision about `nios_` prefix was based on incomplete analysis. Using `nios_` prefix would break the orchestrator-to-scanner handoff.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Key prefix stripping | Generic prefix-strip helper | Direct key updates in each case | Only 6 cases, each with different prefixes; a helper adds indirection for no gain |

## Common Pitfalls

### Pitfall 1: CONTEXT.md says nios_ but ecosystem says wapi_
**What goes wrong:** Following CONTEXT.md literally and using `nios_url`/`nios_username`/`nios_password` would create a second key mismatch: storeCredentials would read `nios_url` but frontend sends `wapi_url` and orchestrator writes `wapi_url`.
**Why it happens:** CONTEXT.md was written without checking the full pipeline.
**How to avoid:** Use `wapi_` prefix to match frontend mock-data.ts, orchestrator, and scanner.
**Warning signs:** Any test that passes `nios_url` instead of `wapi_url` would fail in E2E.

### Pitfall 2: Validator error messages mentioning old key names
**What goes wrong:** After changing validators to read prefixed keys, the error messages (e.g., "url, username, and password are required") become misleading -- they should say "bluecat_url, bluecat_username, and bluecat_password are required".
**How to avoid:** Update error messages to reflect the actual key names.

### Pitfall 3: Missing skip_tls in validator but only fixing storeCredentials
**What goes wrong:** If you fix `storeCredentials` to read `skip_tls` but leave the validator reading `skipTls`, the validation probe itself won't skip TLS even though the session stores it correctly.
**How to avoid:** Fix both storeCredentials AND the validator for each provider.

## Code Examples

### Current storeCredentials bluecat case (WRONG)
```go
// server/validate.go line ~275
case "bluecat":
    var configIDs []string
    if raw := creds["configurationIds"]; raw != "" {  // WRONG: frontend sends "configuration_ids"
        // ...
    }
    sess.Bluecat = &session.BluecatCredentials{
        URL:              creds["url"],       // WRONG: frontend sends "bluecat_url"
        Username:         creds["username"],   // WRONG: frontend sends "bluecat_username"
        Password:         creds["password"],   // WRONG: frontend sends "bluecat_password"
        SkipTLS:          creds["skipTls"] == "true",  // WRONG: frontend sends "skip_tls"
        ConfigurationIDs: configIDs,
    }
```

### Fixed storeCredentials bluecat case
```go
case "bluecat":
    var configIDs []string
    if raw := creds["configuration_ids"]; raw != "" {
        for _, id := range strings.Split(raw, ",") {
            if id = strings.TrimSpace(id); id != "" {
                configIDs = append(configIDs, id)
            }
        }
    }
    sess.Bluecat = &session.BluecatCredentials{
        URL:              creds["bluecat_url"],
        Username:         creds["bluecat_username"],
        Password:         creds["bluecat_password"],
        SkipTLS:          creds["skip_tls"] == "true",
        ConfigurationIDs: configIDs,
    }
```

### Test pattern (follows existing validate_test.go conventions)
```go
func TestStoreCredentials_BluecatPrefixedKeys(t *testing.T) {
    store := session.NewStore()
    h := newTestValidateHandler(store)
    // Stub bluecat validator to avoid real HTTP calls
    h.BluecatValidator = stubOKValidator([]server.SubscriptionItem{{ID: "bluecat", Name: "BlueCat (API v2)"}})

    rec := postValidate(t, store, h, "bluecat", map[string]interface{}{
        "authMethod": "credentials",
        "credentials": map[string]string{
            "bluecat_url":      "https://bam.example.com",
            "bluecat_username": "admin",
            "bluecat_password": "secret",
            "skip_tls":         "true",
            "configuration_ids": "42,99",
        },
    })

    if rec.Code != http.StatusOK {
        t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
    }

    // Extract session and verify fields
    resp := &http.Response{Header: rec.Header()}
    var sessionID string
    for _, c := range resp.Cookies() {
        if c.Name == "ddi_session" {
            sessionID = c.Value
            break
        }
    }
    sess, _ := store.Get(sessionID)
    if sess.Bluecat == nil {
        t.Fatal("expected sess.Bluecat to be set")
    }
    if sess.Bluecat.URL != "https://bam.example.com" {
        t.Errorf("URL = %q, want %q", sess.Bluecat.URL, "https://bam.example.com")
    }
    if !sess.Bluecat.SkipTLS {
        t.Error("expected SkipTLS=true")
    }
    if len(sess.Bluecat.ConfigurationIDs) != 2 || sess.Bluecat.ConfigurationIDs[0] != "42" {
        t.Errorf("ConfigurationIDs = %v, want [42, 99]", sess.Bluecat.ConfigurationIDs)
    }
}
```

## Files to Modify

| File | Changes | Lines Affected |
|------|---------|---------------|
| `server/validate.go` | Update 6 sections: storeCredentials bluecat/efficientip/nios cases + realBluecatValidator + realEfficientIPValidator + realNiosWAPIValidator | ~30 key string literals |
| `server/validate_test.go` | Add tests for bluecat/efficientip/nios prefixed key storage; update any existing tests that use unprefixed keys | ~100 new lines |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Go testing (stdlib) |
| Config file | none (stdlib) |
| Quick run command | `go test ./server/ -run "TestStoreCredentials\|TestValidate_Bluecat\|TestValidate_EfficientIP\|TestValidate_NiosWAPI" -v` |
| Full suite command | `go test ./server/ -v` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BC-02 | Bluecat creds stored with prefixed keys | unit | `go test ./server/ -run TestStoreCredentials_BluecatPrefixedKeys -v` | Wave 0 |
| EIP-02 | EfficientIP creds stored with prefixed keys | unit | `go test ./server/ -run TestStoreCredentials_EfficientIPPrefixedKeys -v` | Wave 0 |
| FE-09 | Bluecat skip_tls and configuration_ids stored | unit | `go test ./server/ -run TestStoreCredentials_BluecatPrefixedKeys -v` | Wave 0 |
| FE-10 | EfficientIP skip_tls and site_ids stored | unit | `go test ./server/ -run TestStoreCredentials_EfficientIPPrefixedKeys -v` | Wave 0 |

### Sampling Rate
- **Per task commit:** `go test ./server/ -run "TestStoreCredentials|TestValidate_Bluecat|TestValidate_EfficientIP|TestValidate_NiosWAPI" -v`
- **Per wave merge:** `go test ./server/ -v`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `TestStoreCredentials_BluecatPrefixedKeys` -- covers BC-02, FE-09
- [ ] `TestStoreCredentials_EfficientIPPrefixedKeys` -- covers EIP-02, FE-10
- [ ] `TestStoreCredentials_NiosWAPIPrefixedKeys` -- covers NIOS WAPI key alignment
- [ ] `TestValidate_BluecatMissingField` -- verifies validator error with prefixed keys
- [ ] `TestValidate_EfficientIPMissingField` -- verifies validator error with prefixed keys

## Sources

### Primary (HIGH confidence)
- `server/validate.go` -- direct code inspection of storeCredentials and all three validators
- `server/validate_test.go` -- existing test patterns and infrastructure
- `frontend/src/app/components/mock-data.ts:277-324` -- actual frontend credential field key definitions
- `frontend/src/app/components/wizard.tsx:1322-1398` -- actual skip_tls, configuration_ids, site_ids key usage
- `frontend/src/app/components/api-client.ts:90-140` -- validateBluecat/validateEfficientip/validateNiosWapi functions
- `internal/orchestrator/orchestrator.go:274-297` -- orchestrator reads session with prefixed keys (already correct)
- `internal/scanner/bluecat/scanner.go:494-500` -- scanner reads bluecat_url/bluecat_username (already correct)
- `internal/scanner/efficientip/scanner.go:52-55` -- scanner reads efficientip_url/efficientip_username (already correct)
- `internal/scanner/nios/wapi.go:100-110` -- scanner reads wapi_url/wapi_username (already correct)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- single file change, Go stdlib, no new dependencies
- Architecture: HIGH -- full credential flow traced end-to-end with code inspection
- Pitfalls: HIGH -- all key mismatches documented with exact line references

**Research date:** 2026-03-13
**Valid until:** indefinite (bug fix, not version-dependent)