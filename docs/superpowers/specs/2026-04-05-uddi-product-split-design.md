# UDDI Product Split: Collector + Architect

**Date:** 2026-04-05
**Status:** Draft
**Author:** Stefan Riegel

---

## Executive Summary

Split the current UDDI Token Calculator into two products:

1. **UDDI Collector** — lightweight, self-contained executable that scans customer infrastructure and exports a data bundle. Runs on Windows, macOS, Linux, and Docker. No auth, no database, no cloud dependency.

2. **UDDI Architect** — SaaS platform where Infoblox SEs and partner architects design UDDI deployments. Import scan data, model NIOS-X and XaaS instance placement, simulate zone migrations, compare architecture scenarios, and produce customer-ready deliverables. Authenticated via Entra ID.

The Collector gathers data. The Architect tells the architecture story.

---

## Problem Statement

The current tool answers "how many tokens do you need?" but not "how should you architect your UDDI deployment?" Pre-sales engineers and solution architects need to:

- Model where NIOS-X and XaaS instances should be placed geographically
- Simulate zone migrations between instances with full delegation chain visibility
- Design hybrid/multi-cloud DNS resolution paths following AWS, Azure, and GCP best practices
- Compare architecture scenarios side by side (3-region vs 2-region, hub-spoke vs distributed)
- Produce deliverables that tell the architecture story, not just list numbers

The tool also serves two distinct users with conflicting needs: **customers** need a lightweight, easy-to-run scanner; **SEs** need a full-featured architecture workbench. These should be separate products.

---

## Users

### UDDI Collector
- **Customer IT teams** — run the scanner in their environment, export results
- **SEs doing quick standalone sizings** — when the full platform isn't needed

### UDDI Architect
- **Infoblox pre-sales engineers** — design UDDI deployments for customer deals
- **Partner architects** — external partners authenticated via Entra ID
- **Solution architects** — internal team doing repeated customer sizings

---

## Product 1: UDDI Collector

### What It Is

Fork of the current UDDI Token Calculator, stripped to a 3-step scan-and-export workflow. The Collector remains a self-contained binary with embedded web UI — same distribution model as today.

### User Flow

```
Step 1: Select Providers (AWS, Azure, GCP, AD, NIOS, Bluecat, EfficientIP)
Step 2: Enter Credentials & Select Sources (accounts, subscriptions, members)
Step 3: Scan → Lite Summary → Export Bundle
```

### Lite Summary (Step 3 results)

After scan completion, the Collector shows a single summary page:

- Total management tokens (DDI / Active IP / Managed Asset)
- Per-provider item counts (zones, networks, records, IPs)
- Scan health: errors and warnings
- **"Upload to UDDI Architect"** button (direct API push when network allows)
- **"Download Bundle"** button (`.uddi` file for air-gapped environments)
- **"Download Excel"** button (standalone use without the Architect)

No detailed findings table, no architecture features, no migration planner. Just enough to confirm the scan worked and give a top-line number.

### What Gets Removed (vs current tool)

- Detailed Findings table with click-to-edit
- Token Breakdown section
- Top Consumer Cards
- Migration Planner (current/hybrid/full scenarios)
- Grid Member Details
- Server Token Calculator
- Manual Sizing Estimator (moves to Architect)
- OutlineNav sidebar
- Growth buffer sliders

### Distribution

- Windows `.exe` (signed)
- macOS binary (Homebrew tap)
- Linux binary (install script)
- Docker image
- Air-gap friendly: no outbound network required for scanning

### Technical Changes from Current Tool

- Fork the current repository
- Strip the React frontend to the 3-step flow + lite summary
- Keep all scanner implementations unchanged
- Add `.uddi` bundle export endpoint (`POST /api/v1/scan/{scanId}/bundle`)
- Add optional Platform API push (`POST /api/v1/scan/{scanId}/upload` with configurable platform URL set via `config.json` or environment variable `UDDI_ARCHITECT_URL`)
- Remove unused frontend components and dependencies
- Binary size target: significantly smaller than current (~15-20MB vs ~30MB)

---

## Product 2: UDDI Architect

### What It Is

A SaaS web application where SEs and partner architects design UDDI deployments. The Architect is the brain — it understands DNS topology, cloud integration patterns, token math, and instance sizing. It helps the SE tell the architecture story.

### Design Philosophy: Enablement Platform

SEs have deep knowledge of NIOS Grid and on-prem DNS/DHCP/IPAM but are weak on two critical fronts:
- **Cloud DNS integration** — how AWS/Azure/GCP DNS connects to UDDI
- **NIOS-X and UDDI itself** — the new product they're selling

The Architect is not just a design tool — it's an **enablement platform** that teaches SEs how to design UDDI deployments while they're doing it. Every screen bridges the gap between what SEs know (NIOS) and what they need to learn (UDDI + cloud).

**Core UX pattern: NIOS → UDDI Translation**

The Architect speaks the SE's language throughout. Instead of abstract UDDI concepts, it maps familiar NIOS concepts to UDDI equivalents:

- "Your NIOS member ns2.corp.com (IB-4030, 12K QPS) → maps to a **XaaS-L** in UDDI. Here's what changes, here's what stays the same."
- "Your NIOS Grid Master role → in UDDI, there is no GM. Management is centralized in the **UDDI Portal**. Your workload distributes across NIOS-X/XaaS instances."
- "Your NIOS zone transfer between members → in UDDI, this becomes **zone delegation** or **secondary zone** on a different NIOS-X instance."
- "Your DHCP failover pair → in UDDI, **HA groups** on XaaS handle this automatically."

**Dual-pane view:** Where applicable, the SE sees their current NIOS world on the left and the target UDDI architecture on the right. The Architect bridges the gap with contextual explanations at every decision point.

**Two guidance levels:**
- **Guided mode** (default): step-by-step flow through the design process. Every decision has context explaining the UDDI concepts and cloud integration implications. Recommended for SEs new to UDDI.
- **Expert mode**: freeform design canvas with contextual side panels for reference. For repeat users who know the concepts and just need the tool. Switchable at any time.

**Guidance depth by domain:**
- **On-prem/NIOS migration → UDDI**: active guidance with NIOS-to-UDDI translation. "Your NIOS Grid with 2 members maps to X in UDDI. Here are your options."
- **Cloud integration**: active guidance with explanations. "You have AWS PHZs — here's how Route53 Resolver endpoints work and why you need them for UDDI."
- **DDI architecture** (zone placement, delegation, failover): lightweight validation only. SEs know DDI. The tool catches mistakes and validates, but trusts SE decisions.

### Authentication & Authorization

- **Entra ID (OIDC/SAML)** — single sign-on for Infoblox employees and partner organizations
- **Roles:**
  - **Admin** — manage users, configure platform settings
  - **SE** — full access: create projects, design architectures, generate deliverables
  - **Partner** — scoped access: assigned projects only, no platform configuration
- **Multi-tenancy:** projects are scoped to teams/regions; partners see only their assigned projects

### Core Modules

#### Module 1: Data Ingestion

Import infrastructure data into a project from multiple sources.

**Capabilities:**
- Upload `.uddi` bundles from Collector (drag-and-drop or API push)
- Manual entry for greenfield designs (no scan data needed)
- Import from customer spreadsheets (CSV/Excel with zone lists, IP counts)
- Merge multiple scan bundles into one project (multi-site customers with separate scans)
- Re-import: update a project with a fresh scan without losing architecture decisions

**Bundle format** (`.uddi`):
```json
{
  "version": "1.0",
  "collectorVersion": "3.1.2",
  "timestamp": "2026-04-05T10:30:00Z",
  "providers": ["aws", "azure", "nios"],
  "findings": [
    {
      "provider": "aws",
      "source": "123456789012",
      "region": "us-east-1",
      "category": "DNS",
      "item": "Route53 Private Hosted Zones",
      "count": 45,
      "tokensPerUnit": 25,
      "managementTokens": 2
    }
  ],
  "niosGrid": {
    "gridName": "corp-grid",
    "niosVersion": "8.6.4",
    "members": [
      {
        "hostname": "ns1.corp.com",
        "role": "GM",
        "zones": 400,
        "qps": 12000,
        "lps": 3000,
        "objects": 850000,
        "activeIPs": 224000,
        "model": "IB-4030"
      }
    ],
    "zones": [
      {
        "fqdn": "corp.internal",
        "type": "authoritative",
        "records": 52000,
        "member": "ns1.corp.com",
        "delegations": ["us.corp.internal", "eu.corp.internal"],
        "qps": 4500
      }
    ],
    "dhcpScopes": [],
    "ipamNetworks": []
  },
  "cloudDns": {
    "aws": {
      "hostedZones": [
        {
          "name": "app.internal",
          "type": "private",
          "records": 120,
          "vpcAssociations": ["vpc-abc123"],
          "region": "us-east-1"
        }
      ],
      "resolverEndpoints": [
        {
          "type": "outbound",
          "region": "us-east-1",
          "rules": [{"domain": "corp.internal", "targetIPs": ["10.0.1.10"]}]
        }
      ]
    },
    "azure": {
      "privateDnsZones": [],
      "privateResolvers": [],
      "vnetLinks": []
    },
    "gcp": {
      "managedZones": [],
      "serverPolicies": [],
      "dnsPeerings": []
    }
  },
  "tokenAggregates": {
    "ddi": 4200,
    "ip": 9665,
    "asset": 1200,
    "total": 9665
  },
  "errors": []
}
```

The bundle carries zone-level detail, member metrics, cloud DNS topology (VPC associations, resolver endpoints, VNet links), and delegation info — everything the Architect needs for architecture exercises.

#### Module 2: Instance Designer

Create and configure the target UDDI deployment: named NIOS-X appliances and XaaS cloud instances.

**Capabilities:**
- Create named instances: "NIOS-X US-East", "XaaS EU-Frankfurt", "NIOS-X APAC-Tokyo"
- Instance properties:
  - **Type:** NIOS-X (on-prem/colo) or XaaS (cloud-hosted)
  - **Location:** region/site label (free text or predefined list)
  - **Role:** Primary authoritative, secondary, forwarder, resolver-only
  - **Tier:** auto-sized based on assigned workload, or manually overridden
- **Deployment templates** as starting points:
  - **Hub & Spoke** — central NIOS-X hub, XaaS spokes per region
  - **3-Region HA** — US / EU / APAC with cross-region secondaries
  - **Regional with Central Forwarding** — regional authorities, central forwarder for cross-region
  - **Migration Bridge** — existing NIOS Grid + new NIOS-X/XaaS coexistence during transition
  - **Custom** — blank canvas
- Auto-sizing: as zones are assigned, the instance tier updates (QPS, LPS, object count → recommended NIOS-X model or XaaS size)
- Capacity warnings: "This instance is at 85% of tier capacity — consider splitting workload"

#### Module 3: DDI Migration Simulator

The core architecture exercise tool. Move DNS zones, DHCP scopes, and IPAM networks between instances and see the impact.

**DNS capabilities:**
- **Drag-and-drop zone assignment:** move a zone from its current location (NIOS member, Route53, Azure DNS) to a target instance (NIOS-X, XaaS)
- **Bulk operations:** "move all zones from NIOS member ns2.corp.com to XaaS EU-Frankfurt"
- **Delegation modeling:**
  - Set delegation: parent zone delegates a subdomain to a different instance
  - Set forwarding: instance forwards queries for a zone to another instance
  - Conditional forwarding: forward only specific domains
  - Secondary/transfer: instance holds a read-only copy of a zone
- **Delegation chain visualization:** see the full resolution path: client → resolver → authoritative → delegation → child authoritative

**DHCP capabilities:**
- **Scope assignment:** move DHCP scopes/ranges to target instances based on site/region
- **Failover modeling:** primary/secondary DHCP relationships between instances
- **Lease capacity:** per-instance active lease count and utilization

**IPAM capabilities:**
- **Network assignment:** assign IPAM networks/blocks to instances
- **Delegation:** parent network blocks delegated to regional instances
- **Utilization view:** per-instance IP utilization and growth projections

**Shared capabilities (all DDI):**
- **Token impact:** real-time recalculation of tokens per instance as objects move
- **Load impact:** QPS, LPS, record/scope/network count, active IP shifts per instance
- **"What if" operations:**
  - "What if we split zone X into two subzones?"
  - "What if we delegate instead of migrate?"
  - "What if we add a forwarder in this region?"
  - "What if we keep this zone on cloud-native DNS and just forward from NIOS-X?"
  - "What if we move DHCP for US-East branches to a local XaaS?"
  - "What if we centralize IPAM management on the hub NIOS-X?"
- **Undo/redo:** full operation history within a scenario

#### Module 4: Cloud Integration Advisor

Best-of-both-worlds DNS architecture for hybrid and multi-cloud environments.

**Design philosophy:** The Architect doesn't assume everything moves to UDDI. It recommends the right tool for each job:
- Use NIOS-X where centralized authority and visibility matter
- Keep cloud-native DNS where it's tightly coupled to cloud services (Private Endpoints, EKS service discovery, GKE internal DNS)
- Design resolution paths per service and per cloud

**AWS integration patterns:**
- Route53 Private Hosted Zones → delegate to NIOS-X for authoritative control, or keep and forward from NIOS-X for cloud-native workloads
- Route53 Resolver endpoints → inbound (cloud → on-prem) and outbound (on-prem → cloud) forwarding to NIOS-X
- PHZ cross-account sharing → centralize in UDDI when multiple accounts need the same zone
- Split-horizon zones → view-based resolution in UDDI with cloud-specific forwarding
- EKS/ECS service discovery → keep on Route53, forward from NIOS-X when cross-environment resolution needed

**Azure integration patterns:**
- Private DNS Zones + VNet links → Azure Private Resolver forwarding to NIOS-X
- Private Endpoints (.privatelink.*) → stay Azure-native, NIOS-X gets conditional forwarding rules
- Hub-spoke VNet topology → NIOS-X as DNS hub, spoke VNets forward via Private Resolver
- AD-integrated DNS → conditional forwarding vs zone transfer depending on migration phase
- Azure Landing Zone alignment → follow Microsoft's recommended DNS topology

**GCP integration patterns:**
- Managed private zones → DNS server policies pointing to NIOS-X as alternate name server
- DNS peering zones → replace with NIOS-X when centralizing cross-project resolution
- Shared VPC DNS → NIOS-X in host project, service projects forward via server policies
- GKE internal DNS (kube-dns) → keep GKE-native, forward from NIOS-X for external resolution
- Cloud Interconnect/VPN → ensure NIOS-X reachability from GCP via private connectivity

**Advisor behavior:**
- When the SE assigns a cloud zone to a NIOS-X instance, the Advisor suggests the integration pattern: "This is an AWS PHZ associated with 3 VPCs — you'll need a Route53 Outbound Resolver endpoint in us-east-1 forwarding to NIOS-X US-East."
- When a zone should stay cloud-native, the Advisor says so: "Azure .privatelink.blob.core.windows.net is tightly coupled to Private Endpoints — recommend keeping it Azure-native with a forwarding rule from NIOS-X for cross-environment resolution."
- Detects and warns about: circular forwarding, orphan zones after migration, split-horizon conflicts, missing resolver endpoints, capacity overload on target instances

**Migration phasing:**
- Phase 1: Coexistence — set up forwarding between existing infrastructure and new NIOS-X/XaaS instances. Both systems active.
- Phase 2: Authority transfer — migrate zone authority to NIOS-X/XaaS. Update delegation records.
- Phase 3: Decommission — remove cloud-native zones that have been fully migrated. Keep cloud-native zones that should stay.

The Advisor models each phase and shows the intermediate DNS topology at each stage.

#### Module 5: Scenario Engine

Compare architecture approaches side by side.

**Capabilities:**
- Create multiple scenarios within a project (e.g., "3-Region HA" vs "Hub-Spoke" vs "Phased Migration")
- Each scenario has its own set of instances, zone assignments, and delegation rules
- **Clone & modify:** duplicate a scenario and make changes ("take Scenario A, add a 4th XaaS in APAC")
- **Side-by-side comparison:**
  - Total tokens per scenario
  - Per-instance token/QPS/LPS breakdown
  - Number of instances and tiers
  - Cloud integration complexity (how many resolver endpoints, forwarding rules)
  - Resilience assessment (single points of failure, cross-region coverage)
  - Estimated cost (based on token pricing and instance tiers)
- **Mark as recommended:** flag one scenario as the recommended architecture
- **Scenario notes:** free-text annotation per scenario explaining the rationale

#### Module 6: DDI Topology View

Visual representation of the entire DDI architecture. Functional data visualization — not a free-form diagramming canvas (SEs use Lucidchart for polished customer diagrams).

**Capabilities:**
- Interactive diagram showing: instances, zones, DHCP scopes, IPAM networks, delegation chains, forwarding rules, resolver endpoints
- Per-instance detail panel: assigned DDI objects, record counts, scope counts, QPS, LPS, token consumption, tier
- Resolution path tracer: "How does a client in Azure VNet X resolve corp.internal?" — shows the full path through resolvers, forwarders, and authoritative servers
- Branch office modeling: show which branch offices or cloud VPCs resolve through which instances
- Conflict highlighting: orphan zones, circular forwarding, delegation gaps, DHCP failover mismatches, overloaded instances
- Filter by: DDI type (DNS/DHCP/IPAM), zone type (authoritative/forwarded/delegated), instance, cloud provider, region
- **Lucidchart/Visio export:** export topology as `.vsdx` file for import into Lucidchart or Visio for polishing

#### Module 7: Deliverables & Reporting

Produce customer-ready output.

**Deliverable types:**
- **PDF Architecture Report:**
  - Executive summary (customer name, date, project scope)
  - Current state overview (what was scanned, token summary)
  - Recommended architecture (topology diagram, instance placement, zone assignments)
  - Cloud integration details (per-cloud resolver setup, forwarding rules)
  - Migration phases (per-phase topology, what changes, what stays)
  - Token sizing (per-instance breakdown, total tokens, BOM)
  - Scenario comparison (if multiple scenarios exist)
- **Excel Export:**
  - Token breakdown (per-instance, per-category)
  - Zone assignment matrix (zone × instance)
  - Cloud integration checklist (what needs to be configured in each cloud)
  - Scenario comparison table
- **Visio/Lucidchart export (.vsdx):**
  - Topology diagram as importable Visio file
  - Instances, zones, delegation arrows, forwarding rules preserved as shapes and connectors
  - SE polishes in Lucidchart/Visio for customer decks
- **Project history:**
  - Version tracking: each save creates a snapshot
  - Compare versions: what changed between iterations
  - Audit trail: who changed what and when

---

## Bundle Format (.uddi)

The `.uddi` file is the data contract between Collector and Architect. It must carry enough detail for the Architect to reconstruct the full picture without re-scanning.

**Key design decisions:**
- JSON format (human-readable, debuggable)
- Versioned schema (`version` field) for forward compatibility
- No credentials or PII — only infrastructure topology and counts
- Zone-level granularity for NIOS data (not just member-level aggregates)
- Cloud DNS topology included (VPC associations, resolver endpoints, VNet links) for the Cloud Integration Advisor
- Signed with HMAC to detect tampering (optional, for enterprise compliance)

**Size expectations:**
- Small customer (single NIOS grid, 1 cloud): ~50KB
- Medium customer (multi-grid, 2-3 clouds): ~500KB
- Large customer (enterprise, all providers): ~2-5MB

---

## Tech Stack

### Collector (fork of current tool)
- Go binary with embedded React (unchanged architecture)
- Same build pipeline: Vite → Go embed → GoReleaser
- Same distribution: exe, macOS, Linux, Docker
- No new dependencies

### Architect (new build — hybrid stack)
- **Frontend:** Next.js (React) with TypeScript, Tailwind CSS, shadcn/ui (consistent with Collector's component library)
- **Backend:** Go API server (reuses calculator, bundle parsing, and exporter packages from Collector codebase)
- **Database:** PostgreSQL (projects, scenarios, user state, audit trail)
- **Auth:** Entra ID via OIDC (Next.js MSAL integration for frontend, Go middleware for API token validation)
- **Hosting:** Azure App Service or containerized deployment (Docker/Kubernetes)
- **Token math:** direct reuse from Go `internal/calculator/` package
- **Bundle parsing:** direct reuse from Go scanner types and NIOS/cloud parsers
- **Diagrams:** React Flow or similar for interactive DDI topology visualization
- **Visio export:** Go library (e.g., `unidoc/unioffice` or direct OOXML generation) for `.vsdx` export
- **PDF generation:** server-side rendering (Puppeteer or Go-native PDF library)
- **Locking:** project-level edit lock with heartbeat (no real-time sync)

---

## Migration Path

### Phase 1: Bundle Format & Collector Fork
- Define and stabilize the `.uddi` bundle schema
- Fork the current repo into `uddi-collector`
- Strip the frontend to 3-step flow + lite summary
- Add bundle export and optional Platform push endpoints
- Ship Collector v1.0

### Phase 2: Architect Foundation
- New repo: `uddi-architect`
- Entra ID authentication + RBAC
- Project CRUD + bundle import
- Token calculation (ported from Go)
- Basic results view (replaces what was removed from Collector)

### Phase 3: Instance Designer + Zone Simulator
- Instance creation with templates
- Zone assignment (drag-and-drop)
- Real-time token recalculation
- Delegation and forwarding modeling
- Undo/redo

### Phase 4: Cloud Integration Advisor
- AWS, Azure, GCP integration pattern rules engine
- Context-aware suggestions when zones are assigned
- Migration phasing (coexistence → authority transfer → decommission)
- Topology validation and conflict detection

### Phase 5: Scenario Engine + Topology View
- Multi-scenario support with clone & modify
- Side-by-side comparison
- Interactive DNS topology diagram
- Resolution path tracer

### Phase 6: Deliverables
- PDF report generation
- Enhanced Excel export
- Shareable read-only links
- Project versioning and history

---

## Resolved Design Decisions

1. **Cloud integration rules:** Hardcoded defaults with per-project overrides. Rules ship as Infoblox best practices; SEs can override individual recommendations with a reason annotation (e.g., "overridden: customer consolidating Azure regions"). Override reasons appear in deliverables to document the decision.

2. **Collaboration:** Turn-based. Multiple SEs can edit a project, but with a lock ("Stefan is editing this project"). Others wait or view read-only. No real-time sync needed.

3. **Pricing data:** No pricing in the Architect. Token counts only. SEs handle pricing through their own tools and quote processes. Keeps the Architect focused on architecture and tokens.

4. **DHCP & IPAM:** Full DDI modeling. DNS zones, DHCP scopes, and IPAM networks all get architecture-level treatment — instance assignment, migration simulation, and what-if modeling. It's Universal DDI, not just DNS.

5. **Offline mode:** SaaS only. The Collector handles air-gapped customer environments. The Architect is a planning tool used by SEs with internet access. Deliverables (PDF/Excel) serve as offline artifacts.

6. **Customer access:** No customer access. The Architect is an internal tool for SEs and partners. Customers receive deliverables as files (PDF architecture report, Excel). No shareable links, no external accounts.

7. **Architect backend language:** Hybrid — Next.js frontend + Go backend API. The Go backend reuses domain logic from the Collector codebase (calculator, bundle parsing, exporter). Next.js handles auth (MSAL/Entra ID), UI, and SaaS concerns. Clear boundary: frontend = TypeScript, backend = Go.

8. **Lucidchart integration:** The Architect exports topology data in Visio format (`.vsdx`) which Lucidchart can import. SEs do the data-driven architecture exercise in the Architect, export, and polish in Lucidchart for customer decks. The Architect's topology view is functional (data visualization, conflict detection, resolution tracing) — not a free-form diagramming canvas.

9. **Best practices architecture:** Templates + rules engine (hybrid). Deployment templates (hub-spoke, 3-region HA, etc.) embed best practices as starting points. A deterministic rules engine validates and suggests improvements as the SE customizes. No AI — fully explainable, every recommendation traceable to a rule.

10. **SE enablement model:** The Architect is an enablement platform, not just a design tool. SEs know NIOS but are new to NIOS-X, UDDI, and cloud DNS. The tool uses NIOS-to-UDDI translation throughout (mapping familiar concepts to new equivalents), a dual-pane current→target view, and two guidance levels: guided mode (step-by-step, default) and expert mode (freeform with contextual panels).

---

## Success Criteria

- SE can go from scan bundle to customer-ready architecture report in under 30 minutes
- Zone migration simulator handles 1000+ zones (DNS), 500+ scopes (DHCP), 200+ networks (IPAM) without performance degradation
- Cloud Advisor recommendations align with AWS Well-Architected, Azure Landing Zone, and GCP best practices documentation
- Scenario comparison clearly shows trade-offs (tokens, complexity, resilience) across all DDI dimensions
- Deliverables are presentation-ready without manual cleanup
- Visio/Lucidchart export accurately represents the designed topology
