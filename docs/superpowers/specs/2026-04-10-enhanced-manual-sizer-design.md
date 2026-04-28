# Enhanced Manual Sizing Estimator — Universal DDI Sizer

**Date:** 2026-04-10
**Status:** Superseded by [2026-04-23-enhanced-manual-sizer-v2-design.md](./2026-04-23-enhanced-manual-sizer-v2-design.md)
**Scope:** Replace the flat Manual Sizing Estimator with a multi-step Universal DDI Sizer for SE pre-sales engagements.

## Goal

Transform the Manual Sizing Estimator into a 5-step wizard that models multi-region, multi-cloud Universal DDI deployments. The SE defines regions, sites, XaaS service points, and NIOS-X systems to produce accurate Management, Server, and Reporting Token estimates plus an exportable draw.io architecture diagram.

## Target User

System Engineers during/after customer discovery calls. Assumes DDI domain knowledge — optimized for speed and accuracy, not hand-holding.

## Data Model

Three-level hierarchy: **Regions → Sites → Infrastructure**.

### Region

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (uuid) | Unique identifier |
| `name` | string | Display name (e.g. "EMEA", "AWS EU") |
| `type` | enum | `on-premises` \| `aws` \| `azure` \| `gcp` |
| `cloudNativeDns` | boolean | Whether this region uses cloud-native DNS (Route53 / Cloud DNS / Azure DNS) managed through Universal DDI |

### Site

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (uuid) | Unique identifier |
| `regionId` | string | Parent region |
| `name` | string | Display name (e.g. "Frankfurt Primary DC", "Branch Offices") |
| `multiplier` | number | Clone count — 1 for unique sites, N for "50 identical branch offices" |
| `activeIPs` | number | Total active IP addresses at this site (per instance if multiplier > 1) |
| `dhcpPct` | number (0-1) | Fraction of IPs served by DHCP |
| `dnsZones` | number | Number of DNS zones managed at this site |
| `networksPerSite` | number | Number of IP networks / VLANs |

**Optional workload drill-down** (collapsed by default, auto-calculates traffic numbers when filled):

| Field | Type | Description |
|-------|------|-------------|
| `dnsRecords` | number? | Total DNS records (overrides auto-calc from activeIPs) |
| `dhcpScopes` | number? | Total DHCP scopes (overrides auto-calc from networksPerSite) |
| `avgLeaseDuration` | number? | Average DHCP lease duration in hours (default: 1) |
| `qpsPerIP` | number? | DNS queries per second per IP (overrides default QPD) |

### XaaS Service Point

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (uuid) | Unique identifier |
| `name` | string | Display name (e.g. "EU XaaS") |
| `popLocation` | string | Official PoP from hardcoded list (see below) |
| `capabilities` | object | `{ dns: boolean, dhcp: boolean, security: boolean, ntp: boolean }` |
| `connectivity` | enum | `ipsec-vpn` \| `aws-tgw` |
| `connectedSiteIds` | string[] | Sites assigned as Access Locations |
| `objectOverride` | number? | Manual override for object count (null = auto-aggregate from sites) |
| `qpsOverride` | number? | Manual override for QPS |
| `lpsOverride` | number? | Manual override for LPS |

**Computed fields** (from connected sites unless overridden):
- `aggregateQps`: sum of connected sites' QPS
- `aggregateLps`: sum of connected sites' LPS
- `aggregateObjects`: sum of connected sites' DNS zones + DHCP scopes (adjusted for multiplier)
- `connections`: count of connected sites (adjusted for multiplier)
- `tier`: auto-calculated from aggregate metrics using existing `XAAS_TOKEN_TIERS`
- `serverTokens`: tier tokens + extra connection tokens if connections > tier.maxConnections

### NIOS-X System

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (uuid) | Unique identifier |
| `name` | string | Display name (e.g. "Backbone DNS-01") |
| `locationSiteId` | string? | Site where this system is placed (null = backbone/shared) |
| `role` | enum | `dns-primary` \| `dns-secondary` \| `dhcp-active` \| `dhcp-standby` \| `dns-dhcp` \| `ipam-reporting` |
| `capabilities` | object | `{ dns: boolean, dhcp: boolean, security: boolean, ntp: boolean }` — auto-set from role, manually adjustable |
| `tierOverride` | string? | T-shirt size override (empty = Custom manual entry) |
| `qps` | number | DNS queries per second |
| `lps` | number | DHCP leases per second |
| `objects` | number | Total managed objects |
| `objectOverride` | number? | Manual override (null = auto from site) |

**Computed fields:**
- `tier`: calculated from qps/lps/objects using existing `SERVER_TOKEN_TIERS`
- `serverTokens`: tier tokens

### Role → Capability Defaults

| Role | DNS | DHCP | Security | Notes |
|------|-----|------|----------|-------|
| DNS Primary | yes | no | optional | QPS-driven |
| DNS Secondary | yes | no | optional | QPS-driven, mirrors primary |
| DHCP Active | no | yes | no | LPS-driven |
| DHCP Standby | no | yes | no | LPS-driven, HA partner |
| DNS+DHCP | yes | yes | optional | Both QPS and LPS |
| IPAM/Reporting | no | no | no | Object-driven |

## Official XaaS PoP Locations

Hardcoded from status.infoblox.com. Updated when Infoblox adds new PoPs.

**AWS (9):**
- US East (N. Virginia)
- US West (Oregon)
- Canada (Central)
- South America (Sao Paulo)
- Asia Pacific (Mumbai)
- Asia Pacific (Hong Kong)
- Asia Pacific (Singapore)
- Europe (Frankfurt)
- Europe (London)

**GCP (2):**
- Europe (London)
- US West (Oregon)

## 5-Step Wizard Flow

The estimator provider replaces the existing flat form. Selecting "Manual Sizing Estimator" in Step 1 (Providers) enters this wizard as Step 2.

### Step 1: Regions & Clouds

- "+ Add Region" button opens inline form: Name, Type dropdown (On-Premises / AWS / Azure / GCP), Cloud-native DNS toggle
- Region cards show name, type badge, site count
- Edit/delete per region
- Minimum 1 region to proceed

### Step 2: Sites per Region

- Region selector at top (or accordion per region)
- "+ Add Site" and "+ Clone Site (x N)" buttons
- Per-site: Name, Active IPs, DHCP%, DNS Zones, Networks per Site
- Collapsible "Workload Details" section for optional drill-down (DNS records, DHCP scopes, lease duration, QPS per IP)
- Clone creates N identical sites with a multiplier badge
- Each site's QPS/LPS auto-calculated from inputs unless overridden in workload details

### Step 3: Infrastructure Placement

Two tabs: **XaaS Service Points** and **NIOS-X Systems**.

**XaaS tab:**
- "+ Add XaaS Service Point" → name, PoP dropdown (11 locations), capabilities checkboxes, connectivity type
- Card shows: name, cloud badge, PoP city, capabilities badges, connected sites as pills, aggregate metrics, tier + tokens
- "+ Assign Site" button per service point → dropdown of unassigned sites
- Connection count = sum of connected sites' multipliers
- Warning when connections exceed tier.maxConnections
- Manual override option for QPS/LPS/Objects (shows "Override" badge)

**NIOS-X tab:**
- "+ Add NIOS-X" → name, location (site dropdown or "Backbone"), role, T-shirt size or Custom
- Table with: Name, Location, Role, Capabilities badges, T-Shirt, QPS, LPS, Objects, Tokens
- Role selection auto-sets capabilities and zeroes irrelevant fields (DNS role → LPS greyed out)
- T-shirt selection locks QPS/LPS/Objects fields (same as existing behavior)

### Step 4: Global Settings

- Module toggles: IPAM, DNS, DHCP (affect management token calc)
- Logging toggles: DNS Protocol Logging, DHCP Lease Logging (affect reporting token calc)
- Reporting destinations: CSP (80/10M), S3 (40/10M), Ecosystem CDC (40/10M), Local Syslog (0) — same as today
- Growth buffer: percentage input applied to all token categories

### Step 5: Results & Topology

**Token Summary:**
- Three hero cards: Management Tokens, Server Tokens, Reporting Tokens
- Per-region breakdown table: Region | Sites | Servers | Mgmt | Server | Reporting

**Actions:**
- Download XLSX — extended report with per-region sheets
- Export draw.io XML — architecture topology diagram
- Back to Estimator — returns to Step 1 of the sizer wizard
- Start Over — full reset

## Token Calculation

### Management Tokens

Per-site calculation (same formulas as today, applied per site):
- DNS records = dynamicClients × 4 + staticClients × 2 (when DNS enabled)
- DHCP objects = networksPerSite × sites × 2 (when DHCP + IPAM enabled)
- DDI objects = (dnsRecords + dhcpObjects) × 1.15 buffer
- Active IPs = activeIPs + 2 × sites × networks (when IPAM enabled)
- Discovered assets = activeIPs (when IPAM enabled)

Sum across all sites (adjusted for multipliers), then:
- Management Tokens = max(ceil(ddiObjects/25), ceil(activeIPs/13), ceil(assets/3))

Growth buffer applied to final total.

### Server Tokens

- XaaS: per service point, tier from aggregate metrics, + extra connection tokens
- NIOS-X: per system, tier from individual metrics
- Sum all server tokens, apply growth buffer

### Reporting Tokens

- Per-site log volume calculated from QPS/LPS (same formulas as today)
- Summed globally across all sites (adjusted for multipliers)
- Applied to global destinations with per-10M-event rates
- Growth buffer applied to total

## Object Auto-Distribution

Sites define DNS zones and DHCP scopes. When a site is assigned to a XaaS service point:
- The site's objects are added to the service point's aggregate
- The XaaS tier is recalculated from the new aggregate

The SE can override the object count on any XaaS service point or NIOS-X system for architectural edge cases (e.g. "this DNS primary handles all 500 zones across all regions"). Override shows a visual "Manual Override" badge and disables auto-aggregation for that field.

## draw.io XML Export

Generates a draw.io-compatible XML file that opens in diagrams.net or draw.io desktop.

### Topology Diagram

- **Regions** as labeled containers (rectangles) with type badge
- **Sites** as nodes inside their region container
- **XaaS Service Points** as cloud-shaped nodes at their PoP location, labeled with tier and capabilities
- **NIOS-X Systems** as server-shaped nodes at their site, labeled with role and tier
- **Connections** as edges from sites to XaaS service points, labeled with connectivity type (VPN/TGW)
- **Cloud-native DNS** regions shown with Route53/CloudDNS/AzureDNS icon

### Token-Annotated Version

Same topology with token counts annotated on each node:
- XaaS: "S tier — 2,400 tokens (10 connections)"
- NIOS-X: "XL — 2,700 tokens (DNS Primary)"
- Region subtotals in the container label

Both versions included in a single XML file as separate pages/tabs.

## Files Changed

### New Files

- `frontend/src/app/components/sizer/` — new directory for sizer components
  - `sizer-types.ts` — Region, Site, XaaS, NIOS-X type definitions
  - `sizer-calc.ts` — multi-region calculation engine (wraps existing estimator-calc.ts formulas)
  - `sizer-wizard.tsx` — 5-step wizard container
  - `regions-step.tsx` — Step 1: region management
  - `sites-step.tsx` — Step 2: site definition per region
  - `infrastructure-step.tsx` — Step 3: XaaS + NIOS-X placement
  - `global-settings-step.tsx` — Step 4: modules, reporting, growth buffer
  - `results-step.tsx` — Step 5: token summary + topology
  - `drawio-export.ts` — draw.io XML generation
  - `xaas-pop-locations.ts` — hardcoded PoP location list
  - `scan-import.ts` — maps scan results (FindingRow[], NiosServerMetrics[], etc.) to sizer data model

### Modified Files

- `frontend/src/app/components/wizard.tsx` — replace flat estimator form with sizer wizard integration, add "Use as Sizer Input" button on results page
- `frontend/src/app/components/estimator-calc.ts` — keep as shared formula library, extend for per-site calc
- `frontend/src/app/components/nios-calc.ts` — unchanged (tier tables reused)

### Unchanged

- Backend Go code — no changes. Scan results are already available in the frontend via the existing polling API. The sizer reads frontend state, not a new endpoint.
- API client — no new endpoints needed
- Excel export — extended with per-region data from the sizer state (frontend-driven)

## Scan Import — Pre-Fill from Discovered Data

The sizer can be entered fresh (empty wizard) or pre-filled from existing scan results. After completing a scan (NIOS Grid, AWS, Azure, GCP, AD), a **"Use as Sizer Input"** button on the results page populates the sizer wizard with discovered data.

### Import Sources

| Source | Maps To | What Gets Imported |
|--------|---------|-------------------|
| NIOS Grid backup | NIOS-X Systems (Step 3) | Member names, roles (DNS/DHCP from services), QPS/LPS/objects per member, model/platform |
| AWS scan | Regions + Sites (Steps 1-2) | One region per scanned AWS region, VPCs as sites, subnet counts as networks, Route53 zones, EC2 IPs |
| Azure scan | Regions + Sites (Steps 1-2) | One region per scanned Azure region, VNets as sites, subnet counts, DNS zones, VM IPs |
| GCP scan | Regions + Sites (Steps 1-2) | One region per scanned GCP region, VPC networks as sites, subnets, Cloud DNS zones, instance IPs |
| AD scan | Sites (Step 2) | DNS zones + DHCP scopes per DC as sites, IP counts from DHCP leases |

### Import Behavior

- **Non-destructive**: Import adds to existing sizer state, does not replace. The SE can import from multiple scans (e.g. NIOS + AWS + Azure).
- **Editable**: All imported values are editable. Import is a starting point, not a locked state.
- **Unmapped fields**: Fields not available from the scan (e.g. XaaS PoP, connectivity type) are left empty for the SE to fill in.
- **NIOS members → NIOS-X**: NIOS Grid members import as NIOS-X systems by default. The SE can convert individual members to XaaS assignments in Step 3 (the migration planning use case).
- **Duplicate detection**: If a region/site with the same name already exists, the import merges (updates counts) rather than creating duplicates.

### Import Flow

1. SE completes a scan (any provider combination)
2. Results page shows "Use as Sizer Input" button
3. Click navigates to the sizer wizard with pre-filled data
4. Imported entries show a subtle "Imported" badge
5. SE reviews, adjusts architecture (assign sites to XaaS, add HA servers, etc.)
6. Proceeds through remaining wizard steps to get token estimates

### What Import Does NOT Do

- Does not auto-create XaaS service points — the SE decides the target architecture
- Does not auto-assign sites to XaaS — site-to-service-point mapping is an architectural decision
- Does not guess connectivity type — the SE picks IPsec VPN or TGW
- Does not set capabilities on XaaS — the SE configures which services run where

## UX Details

### Navigation

- Back button on every step returns to previous step, preserving all state
- Step indicators in the stepper bar: "Regions → Sites → Infrastructure → Settings → Results"
- Steps validate before allowing Next (e.g. must have ≥1 region in Step 1, ≥1 site in Step 2)

### Clone Site (x N)

- Creates a single site entry with `multiplier: N`
- Displayed as "Branch Offices (×50)" with a multiplier badge
- All calculations multiply by N (IPs, objects, connections, log volume)
- Editing the template updates all N instances

### Manual Override Indicator

- Fields with manual override show an amber "Override" badge
- Tooltip: "This value is manually set. Click to revert to auto-calculated."
- Click reverts to auto-aggregation from connected sites

### Validation Warnings

Same warning system as today (amber banner), extended for multi-region:
- XaaS connection limit exceeded
- Site not assigned to any XaaS or NIOS-X
- Region with no sites defined
- Object count mismatch between sites and server totals
