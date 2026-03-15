# Phase 10: NIOS Backend Scanner - Research

**Researched:** 2026-03-10
**Domain:** Go XML streaming, archive/tar + compress/gzip, NIOS onedb.xml schema, session/orchestrator integration
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Grid-level DDI objects (DNS zones, DHCP networks, fixed addresses, host records, network containers, and all other objects without a direct vnode_id) are attributed to the Grid Master member.
- Grid Master attribution applies even if the Master was excluded from the member selection — DDI is attributed to GM, not silently dropped.
- Active IPs are per-member via vnode_id on LEASE objects only. vnode_id → virtual_node.virtual_oid → hostname.
- FindingRow.Source = member hostname (e.g. `frdn77x00.emea.zf-world.com`). Matches AD scanner convention.
- Service-based roles (GM/GMC/DNS/DHCP/DNS+DHCP/IPAM/Reporting) derived from onedb.xml member object.
- Role mapping: Primary node → GM, Candidate master → GMC, DNS only → DNS, DHCP only → DHCP, both → DNS/DHCP, IPAM-only → IPAM, Reporting → Reporting.
- Upload endpoint updated to return service-based roles, not structural Master/Candidate/Regular.
- Single role vocabulary throughout — upload response and niosServerMetrics use the same strings.
- Temp file on disk: upload handler writes to os.TempDir() via os.CreateTemp. Path stored in session Credentials["backup_path"].
- NIOS scanner reads Credentials["backup_path"] inside Scan() and streams (gzip + XML streaming, never loading all 500MB into RAM).
- Cleanup after scan completes — orchestrator or NIOS scanner deferred function deletes the temp file.
- Path passed via existing ScanRequest.Credentials map — no new fields on ScanRequest struct.
- Two-pass streaming parse: Pass 1 builds virtual_oid → hostname member map; Pass 2 counts DDI/IP/Asset objects per member.
- .bak format: treat as plain gzip-compressed tar (same as .tgz) — Phase 9 upload handler already handles this.
- Add NiosServerMetrics []NiosServerMetric json:"niosServerMetrics,omitempty" to ScanResultsResponse in server/types.go.
- NiosServerMetric fields: memberId (hostname), memberName (hostname), role (service role string), qps (0 if not in backup), lps (0 if not in backup), objectCount (sum of DDI FindingRow counts for that member).
- objectCount populated from DDI FindingRows for each member (sum of Count where Category="DDI Objects" and Source=hostname).
- Credentials["selected_members"] carries comma-separated or JSON-encoded hostnames from start scan handler.
- NIOS scanner in Scan() reads Credentials["selected_members"] and filters FindingRows for non-included members.
- Grid Master still receives grid-level DDI even if not explicitly listed (prevent silent DDI loss).

### Claude's Discretion
- Exact temp file naming pattern (os.CreateTemp("", "nios-backup-*.tar.gz"))
- XML streaming library approach (Go standard encoding/xml with xml.NewDecoder)
- Whether QPS/LPS can be extracted from a reporting_queue or RRD file inside the tar.gz
- Error handling when backup_path is missing from Credentials (scan error, not panic)
- Asset count extraction (NIOS-04: Grid Members, HA Pairs, Physical/Virtual Appliances) — derive from member object's appliance type field in onedb.xml

### Deferred Ideas (OUT OF SCOPE)
- QPS/LPS extraction from RRD/reporting_queue files inside the backup — returning 0 is acceptable
- Network-view → member mapping for more precise DHCP attribution
- Re-scan without re-upload for NIOS
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| NIOS-02 | Backend parses onedb.xml to count DDI Objects per Grid Member (17 object types) | XML type-to-family map from _families.py is the direct port target; DDI family set from counter.py |
| NIOS-03 | Backend counts Active IPs per Grid Member (DHCP Active Leases, Static Host IPs, Fixed Address IPs) | vnode_id attribution on LEASE; fixed_address ip_address; host_address "address" key |
| NIOS-04 | Backend counts Assets per Grid Member (Grid Members, HA Pairs, Physical/Virtual Appliances) | virtual_node object fields for appliance type — research needed (see Open Questions) |
| NIOS-05 | Backend extracts QPS/LPS/objectCount per Grid Member as NiosServerMetrics; defaults to 0 | objectCount from DDI rows; QPS/LPS default to 0 per deferred decision |
| NIOS-07 | Scan results deduplicate DNS/DHCP objects across members — attributed to primary member only | Grid-level attribution: all non-LEASE families have no vnode_id → attributed to GM |
| API-02 | GET /api/v1/scan/{scanId}/results returns niosServerMetrics[] alongside findings[] | Add NiosServerMetrics to ScanResultsResponse and populate from session state |
</phase_requirements>

---

## Summary

Phase 10 ports the Python NIOS backup parser to Go. The architecture is a direct translation of the working Python implementation: a two-pass streaming parser over a gzip+tar archive that never loads the full decompressed XML into memory. The primary innovation over the Python version is Go's `encoding/xml` token-based decoder replaces lxml's iterparse, but the structural discovery and field-name knowledge from the ZF Friedrichshafen reference backup (2026-02-28) applies identically.

The code changes span five areas: (1) the NIOS scanner stub (`internal/scanner/nios/scanner.go`) is replaced with the real two-pass parser; (2) `HandleUploadNiosBackup` in `server/scan.go` is extended to write a temp file and return service-based roles; (3) `HandleStartScan` stores selected_members into session Credentials; (4) `server/types.go` gains `NiosServerMetric` type and `ScanResultsResponse.NiosServerMetrics` field; (5) `HandleScanResults` populates niosServerMetrics when NIOS was scanned. The orchestrator and session store require no structural changes — the Credentials map handoff pattern is already used for all other providers.

The XML format is empirically confirmed: every `<OBJECT>` element contains `<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>` children (VALUE attribute, not element text). Go's `encoding/xml` token-based streaming (StartElement/EndElement events) handles this cleanly without loading the DOM. The existing `server/scan.go` streaming code already demonstrates the correct pattern — the niosXMLObject/niosXMLValue structs and the decoder loop in `parseOneDBXML` are the foundation to extend.

**Primary recommendation:** Port _families.py type map and counter.py counting logic directly to Go; extend the existing XML decoder in server/scan.go rather than writing a fresh parser; store NiosServerMetrics in session state alongside TokenResult.

---

## Standard Stack

### Core (all standard library — no new dependencies)
| Library | Package | Purpose | Why Standard |
|---------|---------|---------|--------------|
| encoding/xml | stdlib | Token-based streaming XML decoder | Already used in server/scan.go; memory-flat at any file size |
| archive/tar | stdlib | Streaming tar reader for the backup archive | Already imported in server/scan.go |
| compress/gzip | stdlib | Gzip decompression layer | Already imported in server/scan.go |
| os | stdlib | CreateTemp for the temp file handoff | Standard approach; no new deps |
| strings | stdlib | Join/Split for selected_members encoding | Already used throughout |
| net | stdlib | CIDR parsing for network reservation IPs | net.ParseCIDR replaces Python ipaddress.IPv4Network |

### No New Dependencies
Phase 10 requires zero new Go module dependencies. The entire implementation uses stdlib + existing project packages. This is consistent with the CGO_ENABLED=0 constraint and the pure-Go architecture.

---

## Architecture Patterns

### Recommended Project Structure (additions only)
```
internal/scanner/nios/
├── scanner.go        # Replace stub: two-pass Scan() implementation
├── families.go       # NEW: xmlTypeToFamily map + family constants (port of _families.py)
├── counter.go        # NEW: per-member DDI/IP/Asset accumulator (port of counter.py)
└── roles.go          # NEW: service role extraction from member props (port of objectToMember)

server/
├── scan.go           # Extend: HandleUploadNiosBackup writes temp file; HandleStartScan stores selectedMembers; HandleScanResults appends niosServerMetrics
└── types.go          # Extend: NiosServerMetric type + ScanResultsResponse.NiosServerMetrics field

internal/session/
└── session.go        # Extend: add NiosServerMetrics []NiosServerMetric to Session struct
```

### Pattern 1: Two-Pass Streaming Parse Over Temp File

**What:** Open the gzip+tar file twice. Pass 1 reads only virtual_node OBJECT elements to build the virtual_oid→hostname map. Pass 2 reads all OBJECT elements to count families. Each pass opens the file independently via `os.Open` and streams through gzip+tar+xml.NewDecoder.

**When to use:** Any time you need member resolution before counting — the full member map must be complete before you can attribute lease objects to members.

**Go implementation (Pass 1 — member map):**
```go
// Source: port of _member_map.py + existing server/scan.go decoder pattern
func buildMemberMap(path string) (map[string]string, error) {
    f, err := os.Open(path)
    if err != nil { return nil, err }
    defer f.Close()

    gz, err := gzip.NewReader(f)
    if err != nil { return nil, err }
    defer gz.Close()

    tr := tar.NewReader(gz)
    for {
        hdr, err := tr.Next()
        if err == io.EOF { break }
        if err != nil { return nil, err }
        if filepath.Base(hdr.Name) != "onedb.xml" { continue }
        return parseOnlyMembers(tr)
    }
    return nil, fmt.Errorf("no onedb.xml in backup")
}

func parseOnlyMembers(r io.Reader) (map[string]string, error) {
    memberMap := make(map[string]string)
    dec := xml.NewDecoder(r)
    for {
        tok, err := dec.Token()
        if err == io.EOF { break }
        if err != nil { return nil, err }
        if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "OBJECT" {
            props := collectProps(dec)
            if props["__type"] == ".com.infoblox.one.virtual_node" {
                oid := props["virtual_oid"]
                host := props["host_name"]
                if oid != "" { memberMap[oid] = host }
            }
        }
    }
    return memberMap, nil
}
```

**PROPERTY parsing (inner loop):**
```go
// Source: empirical discovery from ZF backup — _xml_stream.py confirms format
// Each OBJECT child is <PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
// VALUE attribute is the data, not element text.
func collectProps(dec *xml.Decoder) map[string]string {
    props := make(map[string]string)
    for {
        tok, err := dec.Token()
        if err != nil { break }
        switch t := tok.(type) {
        case xml.StartElement:
            if t.Name.Local == "PROPERTY" {
                var name, value string
                for _, a := range t.Attr {
                    switch a.Name.Local {
                    case "NAME": name = a.Value
                    case "VALUE": value = a.Value
                    }
                }
                if name != "" { props[name] = value }
            }
        case xml.EndElement:
            if t.Name.Local == "OBJECT" { return props }
        }
    }
    return props
}
```

**Note:** The existing `server/scan.go` uses a different XML element naming convention (`VALUE` element with `name`/`value` attributes) which **does not match** the confirmed onedb.xml format. The production XML uses `<PROPERTY NAME="..." VALUE="..."/>` children on OBJECT elements. The existing code in objectToMember uses `vals["type"]` — but the confirmed field is `__type`. This discrepancy must be resolved in Phase 10.

**CRITICAL DISCREPANCY (HIGH confidence):** The existing `server/scan.go` `parseOneDBXML()` looks for `VALUE` XML elements with attributes `name`/`value` and checks `vals["type"]`. The empirically confirmed format from the ZF backup is:
- OBJECT children are `<PROPERTY NAME="__type" VALUE="..."/>` (element name is `PROPERTY`, not `VALUE`)
- Type key is `__type`, not `type`
- Structural role fields: `is_grid_master` and `is_candidate_master` on the virtual_node object

The Python `_xml_stream.py` confirms: `for child in elem: name = child.get("NAME"); value = child.get("VALUE")`. The Go parser must use `PROPERTY` element name and `NAME`/`VALUE` attributes.

The existing `objectToMember` check `vals["type"] == "Member"` will never match — it needs to check `props["__type"] == ".com.infoblox.one.virtual_node"`. Phase 10 must fix this in `HandleUploadNiosBackup` as well.

### Pattern 2: Per-Member Accumulator with Global IP Dedup Set

**What:** A single-pass traversal over NiosObject stream, maintaining per-member DDI counters and a global IP dedup set. Grid-level objects accumulate on the Grid Master member.

**Go implementation:**
```go
// Source: port of counter.py count_objects()
type memberAcc struct {
    ddiCount    int
    leaseIPSet  map[string]struct{}
    leaseCount  int
    assetCount  int
}

func countObjects(objects []parsedObject, memberMap map[string]string, gridMasterHostname string) scanCounts {
    globalIPSet := make(map[string]struct{})
    perMember := make(map[string]*memberAcc)

    for _, obj := range objects {
        hostname := resolveHostname(obj, memberMap, gridMasterHostname)
        acc := getOrCreate(perMember, hostname)

        if isDDIFamily(obj.family) {
            delta := ddiDelta(obj)
            acc.ddiCount += delta
        }

        if obj.family == familyLease {
            acc.leaseCount++
            if obj.props["binding_state"] == "active" {
                ip := obj.props["ip_address"]
                if ip != "" {
                    globalIPSet[ip] = struct{}{}
                    acc.leaseIPSet[ip] = struct{}{}
                }
            }
        }
        // fixed_address, host_address, network contribute to globalIPSet only
    }
    // ...
}
```

### Pattern 3: Temp File Handoff Pattern

**What:** Upload handler creates a temp file, writes the multipart body, stores the path in session Credentials. Scanner reads the path, opens the file directly (no HTTP context).

**Go implementation:**
```go
// In HandleUploadNiosBackup:
tmpFile, err := os.CreateTemp("", "nios-backup-*.tar.gz")
if err != nil {
    // error response
}
defer tmpFile.Close()
if _, err := io.Copy(tmpFile, file); err != nil {
    os.Remove(tmpFile.Name())
    // error response
}
tmpPath := tmpFile.Name()

// Store in session Credentials (requires session lookup — needs ScanHandler dependency or
// alternative: return temp path in upload response and let client pass it in start-scan body)
```

**Key architectural note:** `HandleUploadNiosBackup` is currently a standalone function (not a ScanHandler method) — confirmed by Phase 9 decision log: "HandleUploadNiosBackup is a standalone function (no ScanHandler dependency)". To store backup_path in a session, Phase 10 must either:
1. Convert it to a ScanHandler method (gives access to h.store), OR
2. Use the session cookie from the request to look up the session

The session cookie (`ddi_session`) is available on the upload request from the browser — the upload happens after session creation. Reading `r.Cookie("ddi_session")` in the upload handler is the minimal-change approach and avoids converting to a ScanHandler method.

### Pattern 4: Session NiosServerMetrics Storage

**What:** After NIOS Scan() completes, the scanner returns FindingRows (standard interface). NiosServerMetrics are out-of-band data. Two options:
1. Store NiosServerMetrics in the session struct alongside TokenResult (requires Session struct extension)
2. Derive NiosServerMetrics entirely from FindingRows in HandleScanResults (no session struct change)

**Recommended (Option 2 — derive from FindingRows):** After the scan completes, `HandleScanResults` groups findings by Source where Provider=="nios" and Category=="DDI Objects" to compute objectCount per member. Role information must come from somewhere — either stored in Session or re-read from a completed-scan artifact.

**Problem with Option 2:** Role strings are not in FindingRows (the FindingRow schema has no Role field). They must be stored separately.

**Recommended (Option 1 — extend Session struct):** Add `NiosServerMetrics []NiosServerMetric` to `session.Session`. The NIOS scanner writes this after counting. `HandleScanResults` reads it directly. This is consistent with the `TokenResult` pattern.

**Go Session extension:**
```go
// In internal/session/session.go, add to Session struct:
// NiosServerMetrics holds per-member metrics populated by the NIOS scanner.
// Protected by the same state machine as TokenResult: read only after ScanStateComplete.
NiosServerMetrics []NiosServerMetric
```

### Anti-Patterns to Avoid

- **DOM loading:** Never use `xml.Unmarshal` on the full file or `ioutil.ReadAll` on the XML stream — the file is up to 500MB compressed (potentially 2+ GB decompressed). Always use `xml.NewDecoder.Token()`.
- **Double-counting leases in DDI:** LEASE is an IP-attribution family (contributes to Active IPs), not a DDI family. The Python counter.py excludes LEASE from `_DDI_FAMILIES`. Go port must do the same.
- **Summing per-member active IPs for grid total:** Grid active_ip_count = `len(globalIPSet)`, NOT sum of per-member lease IP sets. The per-member sets are lease-only; the global set includes fixed addresses, host addresses, and network reservations.
- **Using the existing objectToMember logic as-is:** The current Go code checks `vals["type"] == "Member"` with `VALUE` child elements — this is wrong. The confirmed XML format uses `PROPERTY` elements with `NAME`/`VALUE` attributes, and the type key is `__type`.
- **Blocking Scan() on file delete:** Use `defer os.Remove(path)` inside Scan(), not after orchestrator.Run() returns, to ensure cleanup even if Scan panics.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CIDR network/broadcast addresses | Custom IPv4 bit math | `net.ParseCIDR` + `net.IPNet` | Handles host-bits-in-mask case (CIDR strict=false equivalent: just use net.ParseCIDR which is non-strict) |
| Gzip decompression | Custom zlib | `compress/gzip.NewReader` | Already in use in server/scan.go |
| Tar entry iteration | Custom tar format parsing | `archive/tar.NewReader` | Already in use in server/scan.go |
| XML streaming | Custom byte scanner | `encoding/xml.NewDecoder` | Token-based; memory-flat; already in use in server/scan.go |
| Temp file management | Custom path generation | `os.CreateTemp` | Atomic unique name + returns *os.File |

**Key insight:** The Python reference needed lxml (not stdlib ElementTree) due to CPython bug #102055 (processed elements not freed from memory tree). Go's `encoding/xml` does not have this problem — it is genuinely token-based and does not build an in-memory tree. Go's stdlib is the right choice here, not a third-party library.

---

## Common Pitfalls

### Pitfall 1: XML Element Name vs. Attribute Name Confusion
**What goes wrong:** Using `xml.Unmarshal` struct tags or checking element names when the data is in attributes on child elements. The `PROPERTY` element carries its data in `NAME` and `VALUE` attributes — not as child text or as attributes on `OBJECT`.
**Why it happens:** The existing Phase 9 code in server/scan.go uses a different assumed format (`VALUE` elements with `name`/`value` attrs) that doesn't match the confirmed ZF backup schema.
**How to avoid:** Use the token loop pattern from Pattern 1 above. When you see a `StartElement` with `Local == "PROPERTY"`, read `NAME` and `VALUE` from `t.Attr`. Confirmed by Python `_xml_stream.py`.
**Warning signs:** objectToMember returns no members during testing against the real backup.

### Pitfall 2: Grid Master Identification Requires Pass 1 Context
**What goes wrong:** You want to attribute grid-level DDI to "the Grid Master" in Pass 2, but you don't know which hostname is the GM until you've read all the member objects.
**Why it happens:** Member objects include `is_grid_master` and `is_candidate_master` boolean properties. These are discovered during Pass 1 alongside virtual_oid and host_name.
**How to avoid:** Extend `buildMemberMap` to also return the GM hostname. Store it alongside the member map. Use it in Pass 2 as the target for all grid-level objects.
**Implementation note:** GM detection: `props["is_grid_master"] == "true"` on a `.com.infoblox.one.virtual_node` object. This matches the existing `objectToMember()` logic in server/scan.go (the field names are correct there; only the element structure detection is wrong).

### Pitfall 3: HOST_OBJECT Expansion Multiplier
**What goes wrong:** Counting each HOST_OBJECT as +1 to DDI when it should expand to +2 (A+PTR) or +3 (A+PTR+CNAME if the `aliases` property is non-empty).
**Why it happens:** The Python counter.py has special-case logic for HOST_OBJECT that is easy to miss when porting.
**How to avoid:** In the DDI counting loop, add a special case: `if family == familyHostObject { if props["aliases"] != "" { delta = 3 } else { delta = 2 } }`.
**Warning signs:** DDI totals are ~30% lower than expected when cross-checking against the Python reference on the ZF backup (129,930 host objects × 2 = significant difference).

### Pitfall 4: NETWORK Objects Contribute to Both DDI and Active IPs
**What goes wrong:** Treating NETWORK as DDI-only and missing the network_address and broadcast_address contributions to the global IP set.
**Why it happens:** The dual role is non-obvious: NETWORK is in `_DDI_FAMILIES` AND contributes IPs.
**How to avoid:** In the IP counting section, handle `familyNetwork` specially: parse the `cidr` property with `net.ParseCIDR`, add network address and broadcast address to globalIPSet.
**Example:**
```go
if obj.family == familyNetwork {
    if cidr := obj.props["cidr"]; cidr != "" {
        _, ipNet, err := net.ParseCIDR(cidr)
        if err == nil {
            globalIPSet[ipNet.IP.String()] = struct{}{}          // network address
            globalIPSet[broadcastAddr(ipNet).String()] = struct{}{} // broadcast
        }
    }
}
```

### Pitfall 5: HOST_ADDRESS Uses "address" Key, Not "ip_address"
**What goes wrong:** Looking for `props["ip_address"]` on HOST_ADDRESS objects and finding nothing.
**Why it happens:** ZF backup empirically stores host record IPs under `address`, not `ip_address`. Confirmed in counter.py comment: "ZF backup stores host record IPs under 'address' key".
**How to avoid:** `ip = obj.props["address"]` for HOST_ADDRESS family.
**Warning signs:** Static Host IPs count is zero in test results despite visible host records.

### Pitfall 6: EXCLUSION_RANGE in DDI Families
**What goes wrong:** Forgetting that EXCLUSION_RANGE (1,815 in ZF backup) is in `_DDI_FAMILIES`. Looking at the API contract's 17 DDI types, it's listed as part of "DHCP Ranges". Emitting a separate FindingRow for EXCLUSION_RANGE when the API contract doesn't list it by name.
**Why it happens:** The Python code counts EXCLUSION_RANGE as a DDI object but the API contract labels DHCP ranges more broadly.
**How to avoid:** Map EXCLUSION_RANGE to the "DHCP Ranges" item label in FindingRows (combine DHCP_RANGE + EXCLUSION_RANGE counts into one row), or emit separate rows. Review the exact item label mapping needed.

### Pitfall 7: Two-Pass Requires File Rewind
**What goes wrong:** After Pass 1 exhausts the tar reader, trying to seek back — but tar readers over gzip streams are not seekable.
**Why it happens:** `io.Reader` has no Seek. Once the gzip stream is exhausted, it cannot be rewound without reopening.
**How to avoid:** Open the temp file independently for each pass: `os.Open(path)` at the start of each pass. Each pass gets a fresh file descriptor, fresh gzip reader, fresh tar reader. This is exactly what the Python `_extractor.py` does (`tarfile.open(path, "r:gz")` each time — seekable mode avoids the streaming limitation).

### Pitfall 8: Session Credentials Map Encoding for selected_members
**What goes wrong:** Storing `[]string` in a `map[string]string` (Credentials is `map[string]string`).
**Why it happens:** Credentials is typed as `map[string]string` — no native slice support.
**How to avoid:** Use `strings.Join(selectedMembers, ",")` to store, `strings.Split(val, ",")` to read. Or `json.Marshal`/`json.Unmarshal` for safety with commas in hostnames (FQDNs don't contain commas, so Join is safe).

---

## Code Examples

### XML Type-to-Family Map (Go port of _families.py)
```go
// Source: empirical ZF Friedrichshafen backup 2026-02-28, _families.py
var xmlTypeToFamily = map[string]string{
    ".com.infoblox.dns.lease":              familyLease,
    ".com.infoblox.dns.bind_ptr":           familyDNSRecordPTR,
    ".com.infoblox.dns.bind_a":             familyDNSRecordA,
    ".com.infoblox.dns.bind_txt":           familyDNSRecordTXT,
    ".com.infoblox.dns.bind_srv":           familyDNSRecordSRV,
    ".com.infoblox.dns.bind_soa":           familyDNSRecordSOA,
    ".com.infoblox.dns.bind_cname":         familyDNSRecordCNAME,
    ".com.infoblox.dns.bind_aaaa":          familyDNSRecordAAAA,
    ".com.infoblox.dns.bind_mx":            familyDNSRecordMX,
    ".com.infoblox.dns.bind_ns":            familyDNSRecordNS,
    ".com.infoblox.dns.host_address":       familyHostAddress,
    ".com.infoblox.dns.host":               familyHostObject,
    ".com.infoblox.dns.network":            familyNetwork,
    ".com.infoblox.dns.fixed_address":      familyFixedAddress,
    ".com.infoblox.dns.host_alias":         familyHostAlias,
    ".com.infoblox.dns.dhcp_range":         familyDHCPRange,
    ".com.infoblox.dns.network_container":  familyNetworkContainer,
    ".com.infoblox.dns.exclusion_range":    familyExclusionRange,
    ".com.infoblox.dns.zone":               familyDNSZone,
    ".com.infoblox.dns.network_view":       familyNetworkView,
    ".com.infoblox.one.virtual_node":       familyMember,
    // DTC families (spec-derived, not empirically validated):
    ".com.infoblox.dns.dtc_lbdn":           familyDTCLBDN,
    ".com.infoblox.dns.dtc_pool":           familyDTCPool,
    ".com.infoblox.dns.dtc_server":         familyDTCServer,
    // dtc_monitor has multiple subtypes mapping to same family:
    ".com.infoblox.dns.dtc_monitor_http":   familyDTCMonitor,
    ".com.infoblox.dns.dtc_monitor_icmp":   familyDTCMonitor,
    ".com.infoblox.dns.dtc_monitor_pdp":    familyDTCMonitor,
    ".com.infoblox.dns.dtc_monitor_sip":    familyDTCMonitor,
    ".com.infoblox.dns.dtc_monitor_snmp":   familyDTCMonitor,
    ".com.infoblox.dns.dtc_monitor_tcp":    familyDTCMonitor,
    ".com.infoblox.dns.dtc_topology_label": familyDTCTopology,
    ".com.infoblox.dns.dtc_topology_rule":  familyDTCTopology,
}
```

### DDI Families Set (Go port of counter.py _DDI_FAMILIES)
```go
// Source: counter.py _DDI_FAMILIES — note LEASE is excluded, EXCLUSION_RANGE included
var ddiItems = map[string]string{
    familyDNSRecordA:       "DNS Resource Records",
    familyDNSRecordAAAA:    "DNS Resource Records",
    familyDNSRecordCNAME:   "DNS Resource Records",
    familyDNSRecordMX:      "DNS Resource Records",
    familyDNSRecordNS:      "DNS Resource Records",
    familyDNSRecordPTR:     "DNS Resource Records",
    familyDNSRecordSOA:     "DNS Resource Records",
    familyDNSRecordSRV:     "DNS Resource Records",
    familyDNSRecordTXT:     "DNS Resource Records",
    familyHostObject:       "Host Records",    // uses +2/+3 expansion
    familyHostAlias:        "Host Records",
    familyDNSZone:          "DNS Authoritative Zones", // needs zone type discrimination
    familyDHCPRange:        "DHCP Ranges",
    familyExclusionRange:   "DHCP Ranges",      // grouped with DHCP Ranges
    familyNetwork:          "DHCP Networks",    // also contributes IPs
    familyNetworkContainer: "Network Containers",
    familyNetworkView:      "Network Views",
    familyFixedAddress:     "DHCP Fixed Addresses",
    familyDTCLBDN:          "DNS Resource Records", // DTC objects — spec-derived
    familyDTCPool:          "DNS Resource Records",
    familyDTCServer:        "DNS Resource Records",
    familyDTCMonitor:       "DNS Resource Records",
    familyDTCTopology:      "DNS Resource Records",
}
```

**Note:** DNS zone type discrimination (Authoritative/Forward/Reverse/Delegated) requires reading zone type properties. The API contract lists four zone types separately. The Python code counts all DNS_ZONE as one family. The Go port needs to inspect the zone's `zone_type` or `fqdn` property to classify it. This is an open question (see below).

### Broadcast Address Helper
```go
// Source: stdlib net package — equivalent to Python ipaddress.IPv4Network broadcast_address
func broadcastAddr(n *net.IPNet) net.IP {
    broadcast := make(net.IP, len(n.IP))
    for i := range n.IP {
        broadcast[i] = n.IP[i] | ^n.Mask[i]
    }
    return broadcast
}
```

### Service Role Mapping (from member props)
```go
// Source: CONTEXT.md decisions + API contract §6
// Member props from onedb.xml virtual_node OBJECT element
func memberServiceRole(props map[string]string) string {
    if props["is_grid_master"] == "true" {
        return "GM"
    }
    if props["is_candidate_master"] == "true" {
        return "GMC"
    }
    // Service flags — field names TBD (see Open Questions)
    hasDNS := props["enable_dns"] == "true"
    hasDHCP := props["enable_dhcp"] == "true"
    hasIPAM := props["enable_ipam"] == "true"    // uncertain field name
    hasReporting := props["enable_reporting"] == "true" // uncertain field name
    switch {
    case hasDNS && hasDHCP:
        return "DNS/DHCP"
    case hasDNS:
        return "DNS"
    case hasDHCP:
        return "DHCP"
    case hasIPAM:
        return "IPAM"
    case hasReporting:
        return "Reporting"
    default:
        return "GM" // fallback — member with no services = Grid member
    }
}
```

### NiosServerMetric Type Addition (server/types.go)
```go
// NiosServerMetric holds per-Grid-Member performance metrics.
// memberId and memberName are both the FQDN for NIOS (no separate stable ID).
type NiosServerMetric struct {
    MemberID    string `json:"memberId"`
    MemberName  string `json:"memberName"`
    Role        string `json:"role"`
    QPS         int    `json:"qps"`
    LPS         int    `json:"lps"`
    ObjectCount int    `json:"objectCount"`
}
```

### ScanResultsResponse Extension (server/types.go)
```go
type ScanResultsResponse struct {
    // ... existing fields ...
    NiosServerMetrics []NiosServerMetric `json:"niosServerMetrics,omitempty"`
}
```

### Session Extension (internal/session/session.go)
```go
type Session struct {
    // ... existing fields ...
    // NiosServerMetrics is populated by the NIOS scanner after scan completes.
    // Read only after State == ScanStateComplete.
    NiosServerMetrics []NiosServerMetric
}
```

**Where does NiosServerMetric type live?** Two options: (a) define in `server/types.go` and import in session — creates import cycle (server imports session); (b) define in a shared package like `internal/scanner/nios/` and import in both. Best approach: define `NiosServerMetric` in `internal/scanner/nios/` as a package-level type, import it in both `internal/session/session.go` and `server/types.go` (server already imports scanner packages via orchestrator). Alternatively, define it in `server/types.go` and NOT store it in session — instead, pass it via a separate mechanism. Simplest: define in `internal/scanner/nios/` and let both consumers import it.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Structural roles (Master/Candidate/Regular) | Service roles (GM/GMC/DNS/DHCP/DNS/DHCP/IPAM/Reporting) | Phase 10 | Upload endpoint returns meaningful roles for Phase 11 XaaS sizing |
| Stub Scan() returning empty | Real two-pass XML streaming parser | Phase 10 | Produces actual FindingRows per-member |
| No temp file (upload discarded after member list) | Temp file persists after upload until scan cleanup | Phase 10 | Enables scanner to re-read the backup without re-upload |
| SSE events for progress | Polling (Phase 9) | Phase 9 complete | Not impacted here |

---

## Open Questions

1. **Member service role field names in onedb.xml virtual_node objects**
   - What we know: `is_grid_master` and `is_candidate_master` are confirmed in the existing Go `objectToMember()` function (these field names came from Phase 9 implementation). The Python code only reads `virtual_oid` and `host_name` — it doesn't extract service roles.
   - What's unclear: The exact PROPERTY names for DNS/DHCP/IPAM/Reporting service flags. Likely candidates: `enable_dns`, `enable_dhcp`, `member_services`, `service_type` — but none are empirically confirmed against the ZF backup.
   - Recommendation: Inspect the ZF backup real virtual_node OBJECT elements to enumerate all PROPERTY NAME values. The file is at `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/do_not_commit/ZF-database-11_1752136302416.bak.reset.tar.gz`. A quick inspection script (or the nios scanner in debug mode) can enumerate all properties on virtual_node objects in Pass 1. **This must be resolved before implementing `memberServiceRole()`** — default to `is_grid_master`/`is_candidate_master` and "DNS/DHCP" as the fallback role for all non-GM/GMC members if field names are not found.

2. **Asset counting field names (NIOS-04)**
   - What we know: API contract lists Grid Members, HA Pairs, Physical Appliances, Virtual Appliances as asset categories. The virtual_node family is the member identity object.
   - What's unclear: How HA pairs are represented (separate HA_PAIR object type? a property on virtual_node?). What property distinguishes Physical vs Virtual Appliance.
   - Recommendation: Inspect ZF backup virtual_node PROPERTY list for `appliance_type`, `hardware_type`, `platform_type`, `is_ha` fields. Likely candidates from NIOS WAPI schema: `platform` (string: "VNIOS", "IB-..." for physical). Count: Grid Members = count of all virtual_node objects; HA Pairs = count where HA property is true; Physical/Virtual = discriminated by platform field.

3. **DNS Zone type discrimination (Authoritative/Forward/Reverse/Delegated)**
   - What we know: API contract has four separate zone item labels. Python code maps all DNS_ZONE to one family. ZF backup has 19,395 zone objects.
   - What's unclear: What property on zone objects indicates zone type (forward vs reverse vs delegated vs authoritative).
   - Recommendation: The `zone_type` or `view_type` property on zone objects. Or discriminate by `fqdn` suffix (`.in-addr.arpa` = Reverse). For Phase 10, emit all zones as a single "DNS Authoritative Zones" row if discrimination is not possible without additional investigation — the token count is unaffected (all zone types count +1 to DDI).

4. **ScanProviderSpec.SelectedMembers — where is it currently?**
   - What we know: `ScanProviderSpec` has `Provider`, `Subscriptions`, `SelectionMode` fields (confirmed in server/types.go). Subscriptions carries member hostnames for NIOS. HandleStartScan calls `toOrchestratorProviders()` which copies `Subscriptions` and `SelectionMode` but NOT into Credentials["selected_members"].
   - What's unclear: Does the existing Phase 9 wizard send member hostnames in `subscriptions`? Yes — wizard.tsx confirmed in CONTEXT.md: "canGoNext credentials case for NIOS: requires credentialStatus='valid' AND niosSelectedMembers.size>0". The selected members are sent in `providers[].subscriptions`.
   - Recommendation: In `buildScanRequest()` in `orchestrator.go`, for `ProviderNIOS` case, read `p.Subscriptions` and store as `req.Credentials["selected_members"] = strings.Join(p.Subscriptions, ",")`. Also store `p.SelectionMode` as `req.Credentials["selection_mode"]`. No new fields on ScanRequest struct needed.

---

## Integration Points Summary (per file)

### server/scan.go — HandleUploadNiosBackup
**Current state:** Calls `parseNiosBackup()` → `parseOneDBXML()` which uses wrong element names. Returns members with structural roles (Master/Candidate/Regular).
**Changes needed:**
1. Fix `parseOneDBXML` to use `PROPERTY` elements with `NAME`/`VALUE` attrs and `__type` key
2. Fix `objectToMember` to check `props["__type"] == ".com.infoblox.one.virtual_node"`
3. Extend `objectToMember` to extract service role from member props (GM/GMC/DNS/DHCP/...)
4. Write multipart file to temp file via `os.CreateTemp`
5. Look up session from `ddi_session` cookie and store `backup_path` in `sess.Credentials["backup_path"]`
6. Return temp path in upload response OR rely on session storage for scanner handoff

### server/scan.go — HandleStartScan
**Changes needed:**
1. After building `providers` list, for NIOS provider: call `h.store.Get(sess.ID)` and store selected members in session Credentials. OR handle in `buildScanRequest()` (orchestrator).

### server/scan.go — HandleScanResults
**Changes needed:**
1. After building `findings` and `errors`, if sess.NiosServerMetrics is non-nil, append to response.

### server/types.go
**Changes needed:**
1. Add `NiosServerMetric` struct (or import from scanner/nios package)
2. Add `NiosServerMetrics []NiosServerMetric json:"niosServerMetrics,omitempty"` to `ScanResultsResponse`
3. Update `NiosGridMember.Role` field comment (already string type, just the values change)

### internal/session/session.go
**Changes needed:**
1. Add `NiosServerMetrics []NiosServerMetric` field to Session struct

### internal/orchestrator/orchestrator.go — buildScanRequest()
**Changes needed:**
1. Add `case scanner.ProviderNIOS:` block — read `backup_path` and `selected_members` from session Credentials (requires session to have these set by upload handler first)

### internal/scanner/nios/scanner.go — Scan()
**Replace entirely with:**
1. Read `backup_path` from Credentials; error if missing
2. Defer `os.Remove(backupPath)` for cleanup
3. Read `selected_members` from Credentials; parse into set
4. `buildMemberMap(backupPath)` — Pass 1
5. Identify GM hostname from member map (GM member has `is_grid_master=="true"` — captured during Pass 1)
6. `countObjects(backupPath, memberMap, gmHostname, selectedMembers)` — Pass 2
7. Convert accumulator results to `[]calculator.FindingRow`
8. Write `NiosServerMetrics` to session (requires session reference — see below)
9. Return FindingRows, nil

**Scanner-session coupling:** The current `Scanner.Scan()` interface signature is `(ctx, req, publish) → ([]FindingRow, error)` — no session pointer. NiosServerMetrics must be communicated back somehow. Options:
- Return metrics as a side-effect via `publish` events (awkward)
- Extend the Scanner interface return to `([]FindingRow, interface{}, error)` (breaks all other scanners)
- Store metrics in a package-level variable keyed by scan (unsafe for concurrency)
- **Best:** Make the NIOS scanner write metrics into a well-known location accessible after the scan: either extend `OrchestratorResult` to include NIOS metrics, or pass a callback to the NIOS scanner for out-of-band data.

**Recommended approach:** Extend `OrchestratorResult` in orchestrator.go to include `NiosServerMetrics []server.NiosServerMetric`. The orchestrator detects if NIOS returned and populates this field. Or: have the NIOS scanner write to a struct field in the session directly (requires passing `*session.Session` into Scan — but that creates a circular dependency with the current interface).

**Simplest approach:** Since NiosServerMetrics are derivable from FindingRows (for objectCount) + member properties (for role), compute them in `HandleScanResults` by scanning `sess.TokenResult.Findings` for NIOS rows. Role strings can be stored in a session-side map that the NIOS scanner populates via the existing session reference held by the orchestrator. The orchestrator already has access to `*session.Session` in the `Run()` goroutine.

**Recommended final pattern:** Add `NiosServerMetrics []NiosServerMetric` to `session.Session`. Have the orchestrator `Run()` goroutine call a `SetNiosMetrics()` method on the session after the NIOS scan completes. The NIOS scanner returns metrics as part of a custom result struct — orchestrator handles the type assertion.

This requires a small interface extension. Alternative: define a `NiosScanner` interface with a `ScanWithMetrics()` method, type-assert in the orchestrator, fall back to plain `Scan()` for other providers. This is the cleanest separation.

---

## Validation Architecture

`nyquist_validation` is enabled in `.planning/config.json`.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Go testing (stdlib) |
| Config file | none (go test ./...) |
| Quick run command | `go test ./internal/scanner/nios/... -v -run TestNIOS` |
| Full suite command | `go test ./... -count=1` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NIOS-02 | DDI counts match reference values from ZF backup | unit | `go test ./internal/scanner/nios/... -run TestDDIFamilyCounts` | ❌ Wave 0 |
| NIOS-03 | Active IP counts: leases via vnode_id, fixed + host IPs in global set | unit | `go test ./internal/scanner/nios/... -run TestActiveIPCounts` | ❌ Wave 0 |
| NIOS-04 | Asset counts from virtual_node objects | unit | `go test ./internal/scanner/nios/... -run TestAssetCounts` | ❌ Wave 0 |
| NIOS-05 | NiosServerMetrics populated with 0 QPS/LPS + correct objectCount | unit | `go test ./internal/scanner/nios/... -run TestNiosServerMetrics` | ❌ Wave 0 |
| NIOS-07 | Grid-level DDI attributed to GM only; no double-counting | unit | `go test ./internal/scanner/nios/... -run TestDeduplication` | ❌ Wave 0 |
| API-02 | Results endpoint includes niosServerMetrics when NIOS scanned | integration | `go test ./server/... -run TestHandleScanResultsNIOS` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `go test ./internal/scanner/nios/... -count=1`
- **Per wave merge:** `go test ./... -count=1`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `internal/scanner/nios/scanner_test.go` — covers NIOS-02, NIOS-03, NIOS-04, NIOS-05, NIOS-07. Needs synthetic test fixture (minimal onedb.xml tar.gz in testdata/).
- [ ] `internal/scanner/nios/testdata/minimal.tar.gz` — synthetic backup with 2 members, representative OBJECT elements for all families. Must be small (< 1MB). Do NOT use the real ZF backup as a test fixture (500MB, in do_not_commit/).
- [ ] `server/scan_nios_test.go` — covers API-02: mock session with NiosServerMetrics, verify JSON response shape.

---

## Sources

### Primary (HIGH confidence)
- ZF Friedrichshafen backup 2026-02-28 empirical discovery (documented in _families.py, _xml_stream.py, _member_map.py) — XML structure, field names, type strings, object counts
- `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/src/cloud_usage/nios/parser/_families.py` — type-to-family map, MEMBER_SCOPED vs GRID_LEVEL classification
- `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/src/cloud_usage/nios/parser/_xml_stream.py` — PROPERTY/NAME/VALUE XML element structure confirmation
- `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/src/cloud_usage/nios/counter.py` — DDI family set, IP dedup logic, HOST_OBJECT expansion, NETWORK dual role
- `/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/src/cloud_usage/nios/parser/_member_map.py` — virtual_oid/host_name field names
- Go stdlib `encoding/xml`, `archive/tar`, `compress/gzip` docs — token-based streaming patterns
- `Web UI for Token Calculation Updated/API_CONTRACT.md` §6 — NiosServerMetric schema
- `server/scan.go` — existing streaming XML decoder pattern (element structure wrong, but decode loop pattern correct)
- `server/types.go`, `internal/session/session.go`, `internal/orchestrator/orchestrator.go`, `internal/scanner/provider.go` — integration point contracts

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions (all locked, verbatim) — attribution rules, role mapping, temp file handoff
- Go `net.ParseCIDR` documentation — non-strict CIDR parsing (equivalent to Python `strict=False`)

### Tertiary (LOW confidence)
- Service role field names in virtual_node PROPERTY elements (`enable_dns`, `enable_dhcp`, etc.) — assumed from NIOS WAPI schema conventions; not empirically confirmed against ZF backup
- Asset type discrimination (Physical vs Virtual Appliance) — `platform` field assumed from NIOS WAPI; not empirically confirmed
- HA Pair representation — unknown; may require backup inspection

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — encoding/xml + archive/tar + compress/gzip already in use; no new dependencies
- XML schema / field names: HIGH for confirmed fields (virtual_oid, host_name, __type, is_grid_master, is_candidate_master, vnode_id, ip_address, binding_state, address, cidr, aliases); LOW for service role and asset type fields
- Architecture: HIGH — two-pass streaming, temp file handoff, session extension patterns all confirmed by Python reference and existing Go code
- Pitfalls: HIGH — based on empirical ZF backup discovery and Python reference code analysis

**Research date:** 2026-03-10
**Valid until:** 2026-04-10 (stable domain — no fast-moving dependencies)