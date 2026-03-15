# Phase 12: NIOS WAPI Scanner + Bluecat & EfficientIP Providers - Research

**Researched:** 2026-03-12
**Domain:** DDI provider REST API integration (NIOS WAPI, Bluecat, EfficientIP)
**Confidence:** HIGH

## Summary

Phase 12 adds three new scanning capabilities: (1) live NIOS Grid scanning via WAPI REST API as an alternative to backup upload, (2) Bluecat DDI provider, and (3) EfficientIP DDI provider. All three are well-documented in the Python reference implementation at `/Users/mustermann/Documents/coding/tmp/cloud-object-counter-master/`. The reference provides exact API endpoints, response parsing, authentication flows, version detection, and object categorization for all three providers.

The existing codebase has clear extension points: the `Scanner` interface in `provider.go`, the orchestrator's fan-out pattern, the session credential store, the validate handler's provider switch, and the frontend's `PROVIDERS` array + `BACKEND_PROVIDER_ID` map. All three new providers follow the same pattern: authenticate, paginate REST endpoints, count DDI objects by category, and return `[]calculator.FindingRow`.

**Primary recommendation:** Port the three Python reference implementations to Go, reusing the existing Scanner interface pattern. The WAPI scanner shares types (NiosServerMetric, families) with the existing backup scanner. Bluecat and EfficientIP are standalone scanners with their own packages. Frontend changes are incremental: add provider cards, credential forms, and WAPI toggle to existing wizard.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- NIOS: Single card with toggle (Upload Backup vs Live API), exclusive modes, WAPI validate discovers Grid Members for Sources step, WAPI version auto-detect with optional override
- Credential Forms: Standard form pattern for Bluecat & EfficientIP (URL + user + pass + Validate), optional advanced section for config IDs / site IDs, Bluecat API v2/v1 auto-detect, EfficientIP Basic/native auth auto-detect
- TLS: All three providers get "Skip TLS verification" checkbox with inline amber hint
- Results: Map to existing token categories (DDI Objects, Active IPs, Assets), WAPI results feed all four NIOS panels, each provider gets own Excel tab, always scan all (no subset option)

### Claude's Discretion
- Retry/backoff strategy for WAPI, Bluecat, and EfficientIP API calls (reference uses exponential backoff)
- HTTP client configuration (timeouts, connection pooling)
- Exact WAPI version probing order and wapidoc parsing
- Internal package structure for the three new scanners
- Bluecat pagination strategy (page size, max pages)
- EfficientIP WHERE clause construction for site filtering

### Deferred Ideas (OUT OF SCOPE)
None
</user_constraints>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| net/http | stdlib | HTTP client for all three provider REST APIs | Pure Go, no CGO, already used throughout |
| crypto/tls | stdlib | TLS skip-verify configuration | InsecureSkipVerify for self-signed certs |
| encoding/json | stdlib | JSON response parsing | Already used for all API responses |
| encoding/base64 | stdlib | EfficientIP native auth header encoding | Base64 username/password in X-IPM headers |
| regexp | stdlib | WAPI version parsing from wapidoc page | Version extraction from HTML |
| html | stdlib | HTML entity handling for wapidoc parsing | Parsing wapidoc page content |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| github.com/go-chi/chi/v5 | existing | Route registration for new validate/upload endpoints | Already in go.mod |
| github.com/xuri/excelize/v2 | existing | Excel export tabs for Bluecat/EfficientIP | Already in go.mod |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| net/http | resty/go-retryablehttp | Extra dependency; reference backoff is simple enough to implement inline |

**No new dependencies required.** All three providers use plain HTTP REST with JSON responses. The Go stdlib provides everything needed.

## Architecture Patterns

### Recommended Package Structure
```
internal/scanner/
  nios/
    scanner.go       # existing backup scanner (unchanged)
    wapi.go          # NEW: WAPI live scanner (implements Scanner + NiosResultScanner)
    counter.go       # existing counting logic (reused by WAPI scanner)
    families.go      # existing family mappings (reused by WAPI scanner)
    roles.go         # existing role extraction (reused by WAPI scanner)
  bluecat/
    scanner.go       # NEW: Bluecat scanner (implements Scanner)
  efficientip/
    scanner.go       # NEW: EfficientIP scanner (implements Scanner)
  provider.go        # existing Scanner interface + provider constants
```

### Pattern 1: Provider Scanner Implementation
**What:** Each new provider implements the `scanner.Scanner` interface.
**When to use:** Every new DDI provider.
**Example:**
```go
// internal/scanner/bluecat/scanner.go
package bluecat

type Scanner struct {
    // no state needed between scans
}

func New() *Scanner { return &Scanner{} }

func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
    // 1. Extract credentials from req.Credentials
    // 2. Authenticate (v2 then v1 fallback)
    // 3. Collect DNS (views, zones, records)
    // 4. Collect IPAM/DHCP (blocks, networks, addresses, ranges)
    // 5. Return FindingRows mapped to token categories
}
```

### Pattern 2: WAPI Scanner as NiosResultScanner
**What:** The WAPI scanner implements both `Scanner` and `NiosResultScanner` interfaces, just like the backup scanner. This allows the orchestrator to extract NiosServerMetrics and feed all four NIOS panels.
**When to use:** NIOS WAPI mode only.
**Key insight:** The WAPI capacityreport endpoint returns per-member object_counts with type names. These must be classified into DNS/IPAM/DHCP categories using the same logic as the Python reference's `_apply_metric()`. The capacityreport also provides `name`, `hardware_type`, `role`, and `total_objects` per member -- these map directly to NiosServerMetric fields.

### Pattern 3: Dual-Mode NIOS Provider Registration
**What:** Register both backup and WAPI scanners under different provider keys. The frontend sends either `nios` (backup mode) or `nios-wapi` (live API mode) as the provider name.
**When to use:** Scan start request routing.
**Key design:** Two approaches:
- **Option A (recommended):** Single `nios` provider key. The `ScanProviderRequest` gains a `Mode` field ("backup" vs "wapi"). The orchestrator checks mode and dispatches to the correct scanner. This keeps the provider card as a single entity.
- **Option B:** Two provider keys (`nios` and `nios-wapi`). Simpler routing but the frontend must manage two separate provider identifiers.

**Recommendation:** Option A -- single `nios` key with a mode field. The frontend toggle sets mode, and the orchestrator dispatches accordingly. This aligns with the user decision of "single NIOS card with toggle."

### Pattern 4: HTTP Client with Retry/Backoff
**What:** Shared retry wrapper for all three providers.
**When to use:** Every REST API call.
**Example:**
```go
// Retry on 429, 500, 502, 503, 504 with exponential backoff
// Respect Retry-After header when present
// Max 3 retries, 1s base backoff, 30s request timeout
type httpClient struct {
    client     *http.Client
    maxRetries int
    backoffBase time.Duration
}
```
**Recommendation:** Each scanner gets its own httpClient instance (not shared) since TLS config and auth differ. The retry logic is simple enough to inline in each package (matching reference impl pattern). If code duplication becomes a concern, extract to `internal/scanner/httpclient/` but this is optional.

### Pattern 5: Validate Endpoint for New Providers
**What:** Each new provider gets a validate handler that tests connectivity and returns subscription/member items.
**Integration points:**
- `server/validate.go`: Add cases to the provider switch in `HandleValidate` and `storeCredentials`
- `server/types.go`: Add credential types
- `internal/session/session.go`: Add credential structs for Bluecat, EfficientIP, NIOS WAPI

**NIOS WAPI validate:** Resolves WAPI version (wapidoc probe -> candidate probe), then calls `GET /wapi/v{version}/capacityreport` to discover Grid Members. Returns members as SubscriptionItems (same shape as backup upload response).

**Bluecat validate:** Authenticates (v2 -> v1 fallback), returns detected API version as info.

**EfficientIP validate:** Authenticates (basic -> native fallback), returns auth mode as info.

### Anti-Patterns to Avoid
- **Separate NIOS provider cards for backup vs WAPI:** User explicitly chose single card with toggle. Do not create two provider entries in PROVIDERS array.
- **Sharing http.Client across providers with different TLS configs:** Each provider needs its own TLS configuration. Create separate clients.
- **Building WAPI metric classification from scratch:** Reuse the Python reference's classification logic (DNS views/zones/records, IPAM blocks/networks/addresses, DHCP leases) -- it handles edge cases in type_name parsing.
- **Adding NIOS WAPI results to a new panel:** WAPI results must feed the SAME four NIOS panels (Top Consumers, Migration Planner, Server Token Calculator, XaaS Consolidation).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WAPI version detection | Custom version resolver | Port reference's 4-step cascade: explicit -> embedded in URL -> wapidoc -> probe candidates | Edge cases in wapidoc HTML parsing, 401/403 vs 404 handling during probe |
| Bluecat auth | Custom token extraction | Port reference's v2/v1 cascade with BAMAuthToken extraction | Legacy token format (`Session Token-> ... <-`) varies across Bluecat versions |
| EfficientIP auth | Custom auth detection | Port reference's basic/native cascade with base64-encoded X-IPM headers | Native headers use base64-encoded username/password, not raw values |
| DNS record type classification | Custom type set | Reuse reference's SUPPORTED_DNS_RECORD_TYPES: A, AAAA, CNAME, MX, TXT, CAA, SRV, SVCB, HTTPS, PTR, NS, SOA, NAPTR | Must match Infoblox token calculation exactly |
| WAPI capacityreport metric parsing | Custom classifier | Port reference's `_apply_metric()` with normalized type name matching | Handles dozens of edge cases: "DHCPv4 Leases" vs "DHCP4 Leases", "IPv4 Blocks" vs "IP4 Blocks", view/zone/record disambiguation |

**Key insight:** The Python reference has been battle-tested against real NIOS grids, Bluecat instances, and EfficientIP deployments. Porting its logic faithfully avoids relearning all the API response format quirks.

## Common Pitfalls

### Pitfall 1: WAPI Version Auto-Detection Failure
**What goes wrong:** wapidoc page is disabled, probe candidates exhausted, auth fails during probe
**Why it happens:** Enterprise NIOS grids often disable wapidoc; older versions not in probe list
**How to avoid:** Implement the full 4-step cascade from reference. On auth failure (401/403) during probe, raise immediately (don't continue probing). Show clear error message with guidance to provide explicit version.
**Warning signs:** 404 on all probe candidates, or 401 that gets swallowed as "version not found"

### Pitfall 2: Bluecat API Version Mismatch
**What goes wrong:** v2 endpoints exist but return empty/different format; v1 fallback not triggered
**Why it happens:** Some Bluecat deployments have partial v2 support
**How to avoid:** v2 auth success does not guarantee v2 endpoints work. Use _count_from_candidates pattern: try v2 path first, on 403/404 fall back to v1 path for each resource type independently.
**Warning signs:** Zero counts from v2 endpoints that should have data

### Pitfall 3: EfficientIP Native Auth Header Encoding
**What goes wrong:** Auth fails on native mode because headers use raw values instead of base64
**Why it happens:** EfficientIP's native auth requires base64-encoded credentials in X-IPM-Username/X-IPM-Password headers
**How to avoid:** Always base64-encode both username and password for native headers (reference: `base64.b64encode(username.encode("utf-8")).decode("ascii")`)
**Warning signs:** 401 errors in native auth mode

### Pitfall 4: WAPI capacityreport Object Count Parsing
**What goes wrong:** Metrics miscounted because object_counts can be list-of-dicts OR dict-of-counts
**Why it happens:** Different NIOS versions return different formats
**How to avoid:** Port `_iter_object_counts()` which handles both: list with type_name/count items, or dict with key/value pairs.
**Warning signs:** Zero object counts from a grid that clearly has objects

### Pitfall 5: Frontend Toggle State Management
**What goes wrong:** User switches from backup to WAPI mode but stale backup token persists in session, or vice versa
**Why it happens:** Toggle doesn't clear previous mode's state
**How to avoid:** When toggle switches: clear backupToken, clear selectedMembers, clear credentialStatus. Each mode starts fresh.
**Warning signs:** Scan uses backup path in WAPI mode or vice versa

### Pitfall 6: TLS Skip-Verify Scope
**What goes wrong:** skip-verify checkbox disables TLS for all HTTP calls in the process
**Why it happens:** Setting InsecureSkipVerify on http.DefaultTransport
**How to avoid:** Create per-scanner http.Client with its own Transport. Never modify http.DefaultClient or http.DefaultTransport.
**Warning signs:** Other providers losing TLS verification when one provider has skip-verify enabled

## Code Examples

### NIOS WAPI: Version Resolution Cascade
```go
// Port of Python reference _resolve_wapi_version()
func (s *WAPIScanner) resolveVersion() (string, error) {
    // 1. Explicit version (user override)
    if s.explicitVersion != "" {
        return s.explicitVersion, nil
    }
    // 2. Embedded in URL (/wapi/v2.13.7/...)
    if v := extractEmbeddedVersion(s.baseURL); v != "" {
        return v, nil
    }
    // 3. wapidoc page probe
    if v, err := s.probeWapidoc(); err == nil && v != "" {
        return v, nil
    }
    // 4. Candidate version probe (2.13.7 down to 2.9.13)
    if v, err := s.probeCandidates(); err == nil && v != "" {
        return v, nil
    }
    return "", fmt.Errorf("unable to resolve WAPI version")
}
```

### NIOS WAPI: Capacity Report to FindingRows
```go
// The capacityreport returns per-member rows with object_counts.
// Each member becomes a source. Metrics are classified into DDI categories.
func (s *WAPIScanner) fetchAndClassify() ([]calculator.FindingRow, []NiosServerMetric, error) {
    version, err := s.resolveVersion()
    if err != nil { return nil, nil, err }

    url := fmt.Sprintf("%s/wapi/v%s/capacityreport", s.baseURL, version)
    // params: _return_fields=name,hardware_type,max_capacity,object_counts,percent_used,role,total_objects

    // Parse response: list of member objects, each with object_counts
    // Classify each type_name into DNS/IPAM/DHCP categories
    // Build FindingRows with Provider="nios", Source=memberName
}
```

### Bluecat: Dual-Version Authentication
```go
// Port of Python reference _authenticate()
func (s *Scanner) authenticate() error {
    // Try v2 first: POST /api/v2/sessions with JSON body
    if err := s.authenticateV2(); err == nil {
        return nil // s.apiMode = "v2", s.authHeader = "Bearer ..."
    }
    // Fall back to v1: GET /Services/REST/v1/login with query params
    return s.authenticateV1() // s.apiMode = "v1", s.authHeader = "BAMAuthToken ..."
}
```

### EfficientIP: Site WHERE Clause
```go
// Port of Python reference _site_where_clause()
func (s *Scanner) siteWhereClause() string {
    if len(s.siteIDs) == 0 { return "" }
    conditions := make([]string, 0, len(s.siteIDs))
    for _, id := range s.siteIDs {
        conditions = append(conditions, fmt.Sprintf("site_id='%s'", id))
    }
    if len(conditions) == 1 { return conditions[0] }
    return "(" + strings.Join(conditions, " or ") + ")"
}
```

### Frontend: NIOS Toggle in Credentials Step
```typescript
// In wizard.tsx, when provider is 'nios':
// Replace isFileUpload branch with dual-mode toggle
const [niosMode, setNiosMode] = useState<'backup' | 'wapi'>('backup');

// backup mode: existing file upload dropzone
// wapi mode: URL + username + password + version (optional) + skip TLS checkbox
```

### Provider Registration in Orchestrator
```go
// main.go or server constructor
scanners := map[string]scanner.Scanner{
    scanner.ProviderAWS:   aws.New(),
    scanner.ProviderAzure: azure.New(),
    scanner.ProviderGCP:   gcp.New(),
    scanner.ProviderAD:    ad.New(),
    scanner.ProviderNIOS:  nios.New(),     // backup scanner (existing)
    // New providers:
    "bluecat":     bluecat.New(),
    "efficientip": efficientip.New(),
}
// WAPI mode: route through nios package's WAPIScanner
// The mode dispatch happens in the orchestrator or via a wrapper
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| NIOS backup-only | Dual mode: backup + WAPI live API | Phase 12 | Users with API access can scan without backup file |
| 5 providers (AWS/Azure/GCP/AD/NIOS) | 7 providers (+Bluecat, +EfficientIP) | Phase 12 | Broader DDI vendor coverage |

## Open Questions

1. **WAPI version probing and authentication semantics**
   - What we know: Reference uses GET /wapi/v{version}/grid with _max_results=1 as probe. 401/403 = auth error (stop), 404 = wrong version (continue).
   - What's unclear: Whether the Go implementation should cache the resolved version in the session for re-scans (probably yes for clone-session UX).
   - Recommendation: Cache version in session credentials map as `wapi_version_resolved`.

2. **Bluecat/EfficientIP results and NIOS panels**
   - What we know: NIOS WAPI results feed all four NIOS panels. Bluecat/EfficientIP results map to token categories.
   - What's unclear: Whether Bluecat/EfficientIP results should show any special panels or just the standard findings table.
   - Recommendation: Standard findings table only (no migration planner, server token calculator for non-NIOS providers). This is confirmed by the user decision: "WAPI results feed all four NIOS panels" (implicitly: only NIOS gets panels).

3. **WAPI metrics to NiosServerMetric mapping**
   - What we know: capacityreport returns per-member name, role, object_counts. QPS/LPS are NOT in capacityreport.
   - What's unclear: Whether QPS/LPS should be 0 for WAPI mode (backup also returns 0 if performance data unavailable).
   - Recommendation: Set QPS=0, LPS=0 for WAPI mode (matching backup behavior when performance data is absent). ObjectCount = total_objects from capacityreport.

4. **Frontend provider ID mapping for new providers**
   - What we know: Existing BACKEND_PROVIDER_ID maps frontend IDs to backend IDs (e.g., 'microsoft' -> 'ad').
   - What's unclear: Whether to use 'bluecat'/'efficientip' as both frontend and backend IDs.
   - Recommendation: Use same IDs for both (no mapping needed). Add `ProviderBluecat = "bluecat"` and `ProviderEfficientIP = "efficientip"` constants.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Go testing + frontend Vite (no explicit test runner detected) |
| Config file | None for Go (standard `go test`); frontend has vite.config.ts |
| Quick run command | `go test ./internal/scanner/nios/... ./internal/scanner/bluecat/... ./internal/scanner/efficientip/... -v -count=1` |
| Full suite command | `go test ./... -count=1` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| P12-01 | WAPI version auto-detection (wapidoc + probe) | unit | `go test ./internal/scanner/nios/ -run TestWAPIVersion -v` | Wave 0 |
| P12-02 | WAPI capacityreport parsing + metric classification | unit | `go test ./internal/scanner/nios/ -run TestWAPICapacity -v` | Wave 0 |
| P12-03 | WAPI validate endpoint discovers members | integration | `go test ./server/ -run TestValidateNiosWAPI -v` | Wave 0 |
| P12-04 | Bluecat v2/v1 auth cascade | unit | `go test ./internal/scanner/bluecat/ -run TestAuth -v` | Wave 0 |
| P12-05 | Bluecat DNS/IPAM/DHCP counting | unit | `go test ./internal/scanner/bluecat/ -run TestCount -v` | Wave 0 |
| P12-06 | EfficientIP basic/native auth cascade | unit | `go test ./internal/scanner/efficientip/ -run TestAuth -v` | Wave 0 |
| P12-07 | EfficientIP DNS/IPAM/DHCP counting + site filter | unit | `go test ./internal/scanner/efficientip/ -run TestCount -v` | Wave 0 |
| P12-08 | NIOS dual-mode toggle (backup vs WAPI) | manual-only | Browser test | N/A -- UI interaction |
| P12-09 | New provider cards visible in Step 1 | manual-only | Browser test | N/A -- UI interaction |
| P12-10 | TLS skip-verify per-provider isolation | unit | `go test ./internal/scanner/bluecat/ -run TestTLS -v` | Wave 0 |

### Sampling Rate
- **Per task commit:** `go test ./internal/scanner/nios/... ./internal/scanner/bluecat/... ./internal/scanner/efficientip/... -v -count=1`
- **Per wave merge:** `go test ./... -count=1`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `internal/scanner/nios/wapi_test.go` -- covers P12-01, P12-02
- [ ] `internal/scanner/bluecat/scanner_test.go` -- covers P12-04, P12-05, P12-10
- [ ] `internal/scanner/efficientip/scanner_test.go` -- covers P12-06, P12-07
- [ ] `server/validate_wapi_test.go` -- covers P12-03

## API Endpoint Reference (from Python Reference)

### NIOS WAPI Endpoints
| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `{base}/wapidoc/` | GET | Version discovery (parse HTML for version links) | HTML page |
| `{base}/wapi/v{ver}/grid` | GET | Auth probe + version validation | JSON array |
| `{base}/wapi/v{ver}/capacityreport?_return_fields=name,hardware_type,max_capacity,object_counts,percent_used,role,total_objects` | GET | Per-member object counts | JSON array of member objects |

### Bluecat Endpoints
| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `/api/v2/sessions` | POST | v2 authentication | JSON with token/credentials |
| `/Services/REST/v1/login` | GET | v1 authentication (fallback) | Token string |
| `/api/v2/views` | GET | DNS views | Paginated JSON |
| `/api/v2/zones` | GET | DNS zones | Paginated JSON |
| `/api/v2/resourceRecords` | GET | DNS records | Paginated JSON with type field |
| `/api/v2/ip4blocks` | GET | IPv4 blocks | Paginated JSON |
| `/api/v2/ip4networks` | GET | IPv4 networks | Paginated JSON |
| `/api/v2/ip4addresses` | GET | IPv4 addresses | Paginated JSON |
| `/api/v2/ip6blocks` | GET | IPv6 blocks | Paginated JSON |
| `/api/v2/ip6networks` | GET | IPv6 networks | Paginated JSON |
| `/api/v2/ip6addresses` | GET | IPv6 addresses | Paginated JSON |
| `/api/v2/dhcp4ranges` | GET | DHCP4 ranges | Paginated JSON |
| `/api/v2/dhcp6ranges` | GET | DHCP6 ranges | Paginated JSON |
| v1 fallback: `/Services/REST/v1/getEntities?type={Type}` | GET | All resources (v1) | JSON array |

### EfficientIP Endpoints
| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `/rest/member_list` | GET | Auth probe | JSON |
| `/rest/dns_view_list` | GET | DNS views | Paginated JSON |
| `/rest/dns_zone_list` | GET | DNS zones | Paginated JSON |
| `/rest/dns_rr_list` | GET | DNS records | Paginated JSON with rr_type |
| `/rest/ip_site_list` | GET | IP sites | Paginated JSON |
| `/rest/ip_subnet_list` | GET | IPv4 subnets | Paginated JSON |
| `/rest/ip_subnet6_list` | GET | IPv6 subnets | Paginated JSON |
| `/rest/ip_pool_list` | GET | IPv4 pools | Paginated JSON |
| `/rest/ip_pool6_list` | GET | IPv6 pools | Paginated JSON |
| `/rest/ip_address_list` | GET | IPv4 addresses | Paginated JSON |
| `/rest/ip_address6_list` | GET | IPv6 addresses | Paginated JSON |
| `/rest/dhcp_scope_list` | GET | DHCP4 scopes | Paginated JSON |
| `/rest/dhcp_scope6_list` | GET | DHCP6 scopes | Paginated JSON |
| `/rest/dhcp_range_list` | GET | DHCP4 ranges | Paginated JSON |
| `/rest/dhcp_range6_list` | GET | DHCP6 ranges | Paginated JSON |

## Token Category Mapping

### NIOS WAPI (from capacityreport object_counts)
| WAPI Metric Type | Token Category | Item Label |
|------------------|---------------|------------|
| DNS views | DDI Objects | NIOS DNS Views |
| DNS zones | DDI Objects | NIOS DNS Zones |
| DNS records (supported types) | DDI Objects | NIOS DNS Records (Supported Types) |
| DNS records (unsupported types) | DDI Objects | NIOS DNS Records (Unsupported Types) |
| IPv4/IPv6 blocks | DDI Objects | NIOS IPv4/IPv6 Blocks |
| IPv4/IPv6 networks | DDI Objects | NIOS IPv4/IPv6 Networks |
| IPv4/IPv6 addresses | DDI Objects | NIOS IPv4/IPv6 Addresses |
| DHCPv4/DHCPv6 leases | Active IPs | NIOS DHCPv4/DHCPv6 Leases |

### Bluecat
| API Resource | Token Category | Item Label |
|-------------|---------------|------------|
| views | DDI Objects | BlueCat DNS Views |
| zones | DDI Objects | BlueCat DNS Zones |
| resourceRecords (supported) | DDI Objects | BlueCat DNS Records (Supported Types) |
| resourceRecords (unsupported) | DDI Objects | BlueCat DNS Records (Unsupported Types) |
| ip4blocks | DDI Objects | BlueCat IP4 Blocks |
| ip4networks | DDI Objects | BlueCat IP4 Networks |
| ip4addresses | DDI Objects | BlueCat IP4 Addresses |
| ip6blocks | DDI Objects | BlueCat IP6 Blocks |
| ip6networks | DDI Objects | BlueCat IP6 Networks |
| ip6addresses | DDI Objects | BlueCat IP6 Addresses |
| dhcp4ranges | DDI Objects | BlueCat DHCP4 Ranges |
| dhcp6ranges | DDI Objects | BlueCat DHCP6 Ranges |

### EfficientIP
| API Resource | Token Category | Item Label |
|-------------|---------------|------------|
| dns_view_list | DDI Objects | EfficientIP DNS Views |
| dns_zone_list | DDI Objects | EfficientIP DNS Zones |
| dns_rr_list (supported) | DDI Objects | EfficientIP DNS Records (Supported Types) |
| dns_rr_list (unsupported) | DDI Objects | EfficientIP DNS Records (Unsupported Types) |
| ip_site_list | DDI Objects | EfficientIP IP Sites |
| ip_subnet_list | DDI Objects | EfficientIP IP4 Subnets |
| ip_subnet6_list | DDI Objects | EfficientIP IP6 Subnets |
| ip_pool_list | DDI Objects | EfficientIP IP4 Pools |
| ip_pool6_list | DDI Objects | EfficientIP IP6 Pools |
| ip_address_list | DDI Objects | EfficientIP IP4 Addresses |
| ip_address6_list | DDI Objects | EfficientIP IP6 Addresses |
| dhcp_scope_list | DDI Objects | EfficientIP DHCP4 Scopes |
| dhcp_scope6_list | DDI Objects | EfficientIP DHCP6 Scopes |
| dhcp_range_list | DDI Objects | EfficientIP DHCP4 Ranges |
| dhcp_range6_list | DDI Objects | EfficientIP DHCP6 Ranges |

### Supported DNS Record Types (from reference constants.py)
A, AAAA, CNAME, MX, TXT, CAA, SRV, SVCB, HTTPS, PTR, NS, SOA, NAPTR

## Integration Touchpoints Summary

### Backend Files to Modify
| File | Change |
|------|--------|
| `internal/scanner/provider.go` | Add `ProviderBluecat`, `ProviderEfficientIP` constants |
| `internal/session/session.go` | Add `Bluecat *BluecatCredentials`, `EfficientIP *EfficientIPCredentials`, `NiosWAPI *NiosWAPICredentials` |
| `internal/orchestrator/orchestrator.go` | Add NIOS mode dispatch, add bluecat/efficientip to buildScanRequest |
| `server/server.go` | Register new validate routes; mount bluecat/efficientip scanners |
| `server/validate.go` | Add bluecat/efficientip/nios-wapi validators + storeCredentials cases |
| `server/types.go` | Add BluecatValidateResponse, EfficientIPValidateResponse types |
| `server/scan.go` | Add bluecat/efficientip cases in toOrchestratorProviders |
| `internal/exporter/exporter.go` | Add bluecat/efficientip Excel tabs |
| `cmd/main.go` (or equivalent) | Register new scanners in orchestrator |

### Backend Files to Create
| File | Purpose |
|------|---------|
| `internal/scanner/nios/wapi.go` | WAPI live scanner |
| `internal/scanner/nios/wapi_test.go` | WAPI unit tests |
| `internal/scanner/bluecat/scanner.go` | Bluecat scanner |
| `internal/scanner/bluecat/scanner_test.go` | Bluecat unit tests |
| `internal/scanner/efficientip/scanner.go` | EfficientIP scanner |
| `internal/scanner/efficientip/scanner_test.go` | EfficientIP unit tests |

### Frontend Files to Modify
| File | Change |
|------|--------|
| `frontend/src/app/components/mock-data.ts` | Add 'bluecat' and 'efficientip' to ProviderType, PROVIDERS, BACKEND_PROVIDER_ID, MOCK_SUBSCRIPTIONS |
| `frontend/src/app/components/wizard.tsx` | Add NIOS backup/WAPI toggle, Bluecat/EfficientIP credential forms, TLS checkbox |
| `frontend/src/app/components/api-client.ts` | Add bluecat/efficientip validate calls, NIOS WAPI validate |

### Frontend Files to Create
| File | Purpose |
|------|---------|
| `frontend/src/assets/logos/bluecat.svg` | Bluecat provider logo |
| `frontend/src/assets/logos/efficientip.svg` | EfficientIP provider logo |

## Sources

### Primary (HIGH confidence)
- Python reference implementation (local copy) -- infoblox_nios.py, bluecat.py, efficientip.py, base.py, constants.py
- Existing Go codebase -- scanner/provider.go, scanner/nios/*, session/session.go, server/*, orchestrator/orchestrator.go

### Secondary (MEDIUM confidence)
- CONTEXT.md user decisions -- all implementation choices locked

### Tertiary (LOW confidence)
- None -- all findings are from direct code analysis

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, all patterns established in codebase
- Architecture: HIGH -- clear extension points, reference implementation covers all APIs
- Pitfalls: HIGH -- derived from reference implementation's error handling and edge cases
- Token mapping: HIGH -- directly from Python reference constants and category assignments

**Research date:** 2026-03-12
**Valid until:** 2026-04-12 (stable -- REST APIs don't change frequently)