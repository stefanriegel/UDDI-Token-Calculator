# Requirements

## Active

### AZ-AUTH-01 — User can authenticate with a certificate-based Service Principal by uploading a PFX or PEM file — handles both SHA1 and SHA256 MAC formats

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: S02

User can authenticate with a certificate-based Service Principal by uploading a PFX or PEM file — handles both SHA1 and SHA256 MAC formats. Backend implemented in S02: realAzureCertificate validator, session storage, scanner credential routing. Frontend certificate upload form pending.

### AZ-AUTH-03 — User can authenticate via Azure Device Code Flow — backend relays the device code and verification URL to the frontend for display

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: S02

User can authenticate via Azure Device Code Flow — backend relays the device code and verification URL to the frontend for display. Backend implemented in S02: realAzureDeviceCode validator with DeviceCodeCredential, credential caching, scanner routing. Frontend device code display pending.

### GCP-AUTH-01 — User can authenticate via Browser OAuth by completing a consent flow — backend runs a localhost redirect server for the authorization code

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: S03

User can authenticate via Browser OAuth by completing a consent flow — backend runs a localhost redirect server for the authorization code. Backend implemented in S03: realGCPBrowserOAuth validator with localhost redirect, CSRF state token, 120s timeout, token source caching, project listing via Cloud Resource Manager API. Frontend OAuth credential form pending.

### GCP-AUTH-02 — User can authenticate via Workload Identity Federation by providing a WIF configuration JSON file

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: S03

User can authenticate via Workload Identity Federation by providing a WIF configuration JSON file. Backend implemented in S03: realGCPWorkloadIdentity validator with structural validation (type=external_account), google.CredentialsFromJSON native WIF support, project ID extraction from SA impersonation URL, token source caching. Frontend WIF upload form pending.

### AD-AUTH-01 — User can authenticate via Kerberos protocol with username, password, realm, and KDC address — pure Go (gokrb5), not Windows SSPI integrated auth

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: S02

User can authenticate via Kerberos protocol with username, password, realm, and KDC address — pure Go (gokrb5), not Windows SSPI integrated auth. Backend implemented in S02: realADKerberosValidator, BuildKerberosClient, session Realm/KDC fields, orchestrator credential mappings. Frontend Kerberos credential form pending.

### AWS-ORG-01 — User can enter org master credentials + role name to discover and scan all child accounts in an AWS Organization

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: M004-2qci81/S02

User can enter org master credentials + role name to discover and scan all child accounts in an AWS Organization. Backend implemented in M004-2qci81/S02: DiscoverAccounts with Organizations ListAccounts, multi-account fan-out with per-account AssumeRole, management account detection, per-account failure tolerance. Frontend org credential form pending S07.

### AWS-RES-01 — AWS scanner counts 19 resource types (5 original + 9 EC2 expanded + 3 Route53/Resolver expanded + 2 original Route53) with correct token categories

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: M004-2qci81/S02

AWS scanner counts 19 resource types: VPCs, subnets, EC2 instances, load balancers, network interfaces (original), elastic IPs, NAT gateways, transit gateways, internet gateways, route tables, security groups, VPN gateways, IPAM pools, VPC CIDR blocks (EC2 expanded), Route53 zones, records (original), health checks, traffic policies, resolver endpoints (Route53/Resolver expanded). Each mapped to correct DDI Objects/Managed Assets category.

### AZ-RES-01 — Azure scanner counts 14 resource types (6 original + 8 expanded) with correct token categories

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: M004-2qci81/S03

Azure scanner counts 14 resource types: VNets, subnets, VMs, load balancers, app gateways, NIC IPs (original), public IPs, NAT gateways, Azure firewalls, private endpoints, route tables, LB frontend IPs, VNet gateways, VNet gateway IPs (expanded). Token categories: DDI Objects (public IPs, route tables), Active IPs (NIC IPs, LB frontend IPs, VNet gateway IPs), Managed Assets (VMs, load balancers, app gateways, NAT gateways, Azure firewalls, private endpoints, VNet gateways).

### GCP-ORG-01 — User can authenticate with org-level SA and discover all org projects via Resource Manager folder traversal for parallel scanning

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: M004-2qci81/S04

User can authenticate with org-level SA and discover all org projects via Resource Manager v3 SearchProjects + BFS ListFolders folder traversal for parallel scanning. Backend implemented in M004-2qci81/S04: DiscoverProjects with BFS folder traversal, multi-project fan-out with per-project progress, non-fatal per-project errors. Frontend org credential form pending S07.

### GCP-RES-01 — GCP scanner counts 13 resource types (6 original + 7 expanded) with correct token categories

- Status: active
- Class: core-capability
- Source: inferred
- Primary Slice: M004-2qci81/S04

GCP scanner counts 13 resource types: VPC networks, subnets, compute instances, load balancers, network interfaces, DNS zones, DNS records (original), compute addresses, firewalls, cloud routers, VPN gateways (HA), VPN tunnels, GKE cluster CIDRs, secondary subnet ranges (expanded). Each mapped to correct DDI Objects/Managed Assets category.

### DNS-TYPE-01 — DNS findings show per-record-type counts (A, AAAA, CNAME, MX, TXT, SRV, etc.) across all three cloud providers

- Status: active
- Class: core-capability
- Source: M004-2qci81 success criteria
- Primary Slice: M004-2qci81/S06

All three cloud scanners (AWS Route53, Azure DNS, GCP Cloud DNS) emit per-type DNS record FindingRows (`dns_record_a`, `dns_record_aaaa`, `dns_record_cname`, etc.) instead of a single generic `dns_record` row. Shared `SupportedDNSTypes` set (13 types) in `cloudutil/dns.go`. Backend complete in M004-2qci81/S06. Frontend display of per-type breakdown pending S07.

## Validated

### NIOS-01 — User can upload a NIOS Grid backup file (`.tar.gz`, `.tgz`, or `.bak`) and receive a list of discovered Grid Members with their roles

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

User can upload a NIOS Grid backup file (`.tar.gz`, `.tgz`, or `.bak`) and receive a list of discovered Grid Members with their roles

### NIOS-02 — Backend parses `onedb.xml` inside the backup to count DDI Objects per Grid Member (17 object types: DNS Authoritative/Forward/Reverse/Delegated Zones, DNS Resource Records, Host Records, DNS Views, Network Views, DHCP Networks/Ranges/Fixed Addresses/Failover Associations/Option Spaces, IP Networks/Ranges, Network Containers, Extensible Attributes)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Backend parses `onedb.xml` inside the backup to count DDI Objects per Grid Member (17 object types: DNS Authoritative/Forward/Reverse/Delegated Zones, DNS Resource Records, Host Records, DNS Views, Network Views, DHCP Networks/Ranges/Fixed Addresses/Failover Associations/Option Spaces, IP Networks/Ranges, Network Containers, Extensible Attributes)

### NIOS-03 — Backend counts Active IPs per Grid Member (DHCP Active Leases, Static Host IPs, Fixed Address IPs)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Backend counts Active IPs per Grid Member (DHCP Active Leases, Static Host IPs, Fixed Address IPs)

### NIOS-04 — Backend counts Assets per Grid Member (Grid Members, HA Pairs, Physical Appliances, Virtual Appliances)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Backend counts Assets per Grid Member (Grid Members, HA Pairs, Physical Appliances, Virtual Appliances)

### NIOS-05 — Backend extracts QPS/LPS/objectCount per Grid Member as NiosServerMetrics; defaults to 0 if performance data unavailable in backup

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Backend extracts QPS/LPS/objectCount per Grid Member as NiosServerMetrics; defaults to 0 if performance data unavailable in backup

### NIOS-06 — User can select which Grid Members to include/exclude before scanning

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

User can select which Grid Members to include/exclude before scanning

### NIOS-07 — Scan results deduplicate DNS/DHCP objects across members — objects attributed to primary member only

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Scan results deduplicate DNS/DHCP objects across members — objects attributed to primary member only

### API-01 — Scan progress is available via `GET /api/v1/scan/{scanId}/status` (polling every 1.5s) replacing SSE

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Scan progress is available via `GET /api/v1/scan/{scanId}/status` (polling every 1.5s) replacing SSE

### API-02 — `GET /api/v1/scan/{scanId}/results` returns `niosServerMetrics[]` alongside `findings[]` when NIOS is present

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

`GET /api/v1/scan/{scanId}/results` returns `niosServerMetrics[]` alongside `findings[]` when NIOS is present

### API-03 — `POST /api/v1/providers/nios/upload` endpoint accepts multipart backup file (`.tar.gz`, `.tgz`, `.bak`) up to 500MB

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

`POST /api/v1/providers/nios/upload` endpoint accepts multipart backup file (`.tar.gz`, `.tgz`, `.bak`) up to 500MB

### FE-01 — Frontend is updated to match the Figma Make redesign — changes from `Web UI for Token Calculation Updated/` are applied INCREMENTALLY to the existing `frontend/` (wizard.tsx, api-client.ts, use-backend.ts updated; NOT a wholesale replacement)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Frontend is updated to match the Figma Make redesign — changes from `Web UI for Token Calculation Updated/` are applied INCREMENTALLY to the existing `frontend/` (wizard.tsx, api-client.ts, use-backend.ts updated; NOT a wholesale replacement)

### FE-02 — NIOS provider card appears in Step 1 (Select Providers) with file upload flow in Step 2 instead of credential form

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

NIOS provider card appears in Step 1 (Select Providers) with file upload flow in Step 2 instead of credential form

### FE-03 — Results step shows Top Consumer Cards (DNS, DHCP, IP/Network — expandable, top 5 per category, client-side only)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Results step shows Top Consumer Cards (DNS, DHCP, IP/Network — expandable, top 5 per category, client-side only)

### FE-04 — Results step shows NIOS-X Migration Planner (3-scenario comparison: Current/Hybrid/Full UDDI) when NIOS was scanned

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Results step shows NIOS-X Migration Planner (3-scenario comparison: Current/Hybrid/Full UDDI) when NIOS was scanned

### FE-05 — Results step shows Server Token Calculator (per-member form factor selection: NIOS-X on-prem vs XaaS) when NIOS was scanned

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Results step shows Server Token Calculator (per-member form factor selection: NIOS-X on-prem vs XaaS) when NIOS was scanned

### FE-06 — Results step shows XaaS Consolidation panel (bin-packing with S/M/L/XL tiers, connection limits, extra connections at 100 tokens each)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Results step shows XaaS Consolidation panel (bin-packing with S/M/L/XL tiers, connection limits, extra connections at 100 tokens each)

### FE-07 — New provider logos (SVG) and import data files (performance-specs.csv, performance-metrics.csv, cloud-bucket-crosswalk.md) copied into `frontend/public/logos/` and `frontend/src/imports/`

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

New provider logos (SVG) and import data files (performance-specs.csv, performance-metrics.csv, cloud-bucket-crosswalk.md) copied into `frontend/public/logos/` and `frontend/src/imports/`

### WAPI-01 — NIOS WAPI scanner resolves API version via 4-step cascade (explicit override, embedded URL, wapidoc probe, candidate version probe) and fetches capacityreport

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

NIOS WAPI scanner resolves API version via 4-step cascade (explicit override, embedded URL, wapidoc probe, candidate version probe) and fetches capacityreport

### WAPI-02 — NIOS WAPI scanner classifies capacityreport metrics into DDI Objects and Active IPs categories, produces NiosServerMetrics per member, and feeds all four NIOS panels identically to backup parsing

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

NIOS WAPI scanner classifies capacityreport metrics into DDI Objects and Active IPs categories, produces NiosServerMetrics per member, and feeds all four NIOS panels identically to backup parsing

### BC-01 — Bluecat scanner authenticates via v2 API (POST /api/v2/sessions) with v1 fallback (GET /Services/REST/v1/login) and detects API version

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Bluecat scanner authenticates via v2 API (POST /api/v2/sessions) with v1 fallback (GET /Services/REST/v1/login) and detects API version

### BC-02 — Bluecat scanner counts DNS (views, zones, records with supported/unsupported split), IPAM (IPv4/IPv6 blocks, networks, addresses), and DHCP (DHCPv4/v6 ranges) with optional configuration ID filtering

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Bluecat scanner counts DNS (views, zones, records with supported/unsupported split), IPAM (IPv4/IPv6 blocks, networks, addresses), and DHCP (DHCPv4/v6 ranges) with optional configuration ID filtering

### EIP-01 — EfficientIP scanner authenticates via HTTP Basic with native X-IPM header fallback (base64-encoded credentials) and detects auth mode

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

EfficientIP scanner authenticates via HTTP Basic with native X-IPM header fallback (base64-encoded credentials) and detects auth mode

### EIP-02 — EfficientIP scanner counts DNS (views, zones, records), IPAM (sites, subnets, pools, addresses), and DHCP (scopes, ranges) with optional site ID filtering

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

EfficientIP scanner counts DNS (views, zones, records), IPAM (sites, subnets, pools, addresses), and DHCP (scopes, ranges) with optional site ID filtering

### INT-01 — Session types, provider constants, and credential storage for Bluecat, EfficientIP, and NIOS WAPI mode

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Session types, provider constants, and credential storage for Bluecat, EfficientIP, and NIOS WAPI mode

### INT-02 — Validate endpoints for Bluecat, EfficientIP, and NIOS WAPI mode (discovers Grid Members for Sources step)

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Validate endpoints for Bluecat, EfficientIP, and NIOS WAPI mode (discovers Grid Members for Sources step)

### INT-03 — Orchestrator wiring, scan routing (NIOS mode dispatch), and scanner registration in main.go

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Orchestrator wiring, scan routing (NIOS mode dispatch), and scanner registration in main.go

### FE-08 — NIOS provider card shows toggle between Upload Backup and Live API modes; switching clears stale state

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

NIOS provider card shows toggle between Upload Backup and Live API modes; switching clears stale state

### FE-09 — Bluecat provider card with credential form (URL + username + password), TLS skip checkbox, optional advanced section for configuration IDs

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

Bluecat provider card with credential form (URL + username + password), TLS skip checkbox, optional advanced section for configuration IDs

### FE-10 — EfficientIP provider card with credential form (URL + username + password), TLS skip checkbox, optional advanced section for site IDs

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

EfficientIP provider card with credential form (URL + username + password), TLS skip checkbox, optional advanced section for site IDs

### FE-11 — API client functions for bluecat/efficientip validate and NIOS WAPI validate; scan start includes mode field for NIOS

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

API client functions for bluecat/efficientip validate and NIOS WAPI validate; scan start includes mode field for NIOS

### VERIFY-01 — All new provider UI elements render correctly, existing providers unaffected, full test suite passes

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

All new provider UI elements render correctly, existing providers unaffected, full test suite passes

### AWS-AUTH-01 — User can authenticate with an AWS CLI Profile by selecting a named profile from `~/.aws/credentials` — backend reads shared config

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

User can authenticate with an AWS CLI Profile by selecting a named profile from `~/.aws/credentials` — backend reads shared config

### AWS-AUTH-02 — User can authenticate via AWS Assume Role (STS) for cross-account scanning by providing a Role ARN and optional external ID — credentials auto-refresh during long scans

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

User can authenticate via AWS Assume Role (STS) for cross-account scanning by providing a Role ARN and optional external ID — credentials auto-refresh during long scans

### AZ-AUTH-02 — User can authenticate via Azure CLI (`az login`) session when the `az` binary is installed — shows clear error if `az` is not found

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

User can authenticate via Azure CLI (`az login`) session when the `az` binary is installed — shows clear error if `az` is not found

### AD-AUTH-02 — User can connect to AD via WinRM over HTTPS (port 5986) when PowerShell Remoting is selected — with TLS certificate validation toggle

- Status: validated
- Class: core-capability
- Source: inferred
- Primary Slice: none yet

User can connect to AD via WinRM over HTTPS (port 5986) when PowerShell Remoting is selected — with TLS certificate validation toggle

## Deferred

## Out of Scope
