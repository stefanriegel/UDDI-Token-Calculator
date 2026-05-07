# DDI Scanner — Go Backend API Contract

> **Purpose**: This document defines the REST API that the Go `ddi-scanner.exe` backend must implement. The React frontend (built with Vite, served as embedded static files) communicates exclusively through these endpoints using same-origin relative URLs.

---

## Architecture Overview

```
ddi-scanner.exe (single binary)
├── Embedded SPA (Go embed.FS)     →  serves /index.html, /assets/*
├── REST API                       →  serves /api/v1/*
└── Scanner engines (per provider) →  AWS, Azure, GCP, MS DHCP/DNS
```

The Go binary serves both the static SPA and the API on the **same port** (default `:8080`). The frontend uses relative URLs (`/api/v1/...`) — no CORS configuration is needed.

**SPA Fallback**: The frontend is a single-page app with NO client-side routing. All navigation is in-memory wizard state. The Go server only needs to serve `index.html` for `/` and static assets from `/assets/`. No SPA fallback/catch-all route is needed.

---

## Base Configuration

| Setting | Value |
|---------|-------|
| Default listen address | `:8080` |
| API prefix | `/api/v1` |
| Content-Type (all responses) | `application/json` |
| Static files source | `dist/` directory (Go `//go:embed dist/*`) |

---

## Error Response Format (all endpoints)

All non-2xx responses MUST return this JSON body:

```json
{
  "error": "Human-readable error message"
}
```

HTTP status codes to use:
- `400` — Bad request / validation error
- `401` — Authentication failed
- `404` — Resource not found (e.g. unknown scanId)
- `500` — Internal server error

---

## Endpoints

### 1. Health Check

The frontend polls this every 8 seconds to detect whether the backend is running. A 3-second timeout is enforced client-side.

```
GET /api/v1/health
```

**Response** `200 OK`:

```json
{
  "status": "ok",
  "version": "1.2.0"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok" \| "degraded" \| "error"` | `"ok"` = all systems go. `"degraded"` = partial functionality (e.g. one cloud SDK unavailable). `"error"` = critical failure. |
| `version` | `string` | Semver version of the Go binary, displayed in the UI header badge. |

**Frontend behavior**:
- On success → shows green "Connected v1.2.0" badge, uses real API for all subsequent calls.
- On failure/timeout → shows amber "Demo Mode" banner, falls back to mock data for all flows.

---

### 2. Validate Credentials

Validates provider credentials and, on success, returns the list of discoverable accounts/subscriptions/projects/servers.

```
POST /api/v1/providers/{provider}/validate
```

**Path parameters**:

| Parameter | Type | Values |
|-----------|------|--------|
| `provider` | `string` | `"aws"`, `"azure"`, `"gcp"`, `"microsoft"` |

**Request body**:

```json
{
  "authMethod": "sso",
  "credentials": {
    "ssoStartUrl": "https://my-org.awsapps.com/start",
    "ssoRegion": "us-east-1"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `authMethod` | `string` | The authentication method ID selected by the user (see Auth Methods table below). |
| `credentials` | `Record<string, string>` | Key-value pairs matching the fields defined for the selected auth method. May be empty `{}` for zero-field methods (e.g. `"browser-oauth"`, `"az-cli"`, `"kerberos"`, `"adc"`). |

**Auth Methods per Provider**:

| Provider | `authMethod` ID | Fields (credential keys) | Notes |
|----------|-----------------|--------------------------|-------|
| **aws** | `sso` | `ssoStartUrl`, `ssoRegion` | Opens browser for IAM Identity Center SSO |
| **aws** | `profile` | `profile` | Uses named AWS CLI profile |
| **aws** | `access-key` | `accessKeyId`, `secretAccessKey`, `region` | Static IAM credentials |
| **aws** | `assume-role` | `roleArn`, `externalId` (optional), `sourceProfile` | STS AssumeRole |
| **azure** | `browser-sso` | `tenantId` | Opens browser for Entra ID login |
| **azure** | `device-code` | `tenantId` | Device code flow |
| **azure** | `service-principal` | `tenantId`, `clientId`, `clientSecret` | App registration with secret |
| **azure** | `certificate` | `tenantId`, `clientId`, `certPath` | App registration with X.509 cert |
| **azure** | `az-cli` | *(none)* | Uses existing `az login` session |
| **gcp** | `browser-oauth` | *(none)* | Opens browser for Google OAuth |
| **gcp** | `adc` | *(none)* | Uses `gcloud auth application-default` |
| **gcp** | `service-account` | `serviceAccountJson` | JSON key file contents or path |
| **gcp** | `workload-identity` | `projectNumber`, `poolId`, `providerId`, `serviceAccountEmail` | Federated identity |
| **microsoft** | `kerberos` | `server` | Windows integrated auth (current user) |
| **microsoft** | `ntlm` | `server`, `username`, `password` | Domain credentials |
| **microsoft** | `powershell-remote` | `server`, `username`, `password`, `useSSL` | WinRM remoting |

**Response** `200 OK` (success):

```json
{
  "valid": true,
  "subscriptions": [
    { "id": "sub-001", "name": "Production – East US" },
    { "id": "sub-002", "name": "Development – West Europe" },
    { "id": "sub-003", "name": "Security – SOC Platform" }
  ]
}
```

**Response** `200 OK` (validation failed — credentials rejected):

```json
{
  "valid": false,
  "error": "Authentication failed: invalid client secret for tenant abc123",
  "subscriptions": []
}
```

**Response** `200 OK` (browser auth required — for SSO/OAuth methods):

For methods like `sso`, `browser-sso`, `browser-oauth`, `device-code`, the Go backend should:
1. Start a local callback server (if needed)
2. Open the user's default browser to the auth URL
3. Wait for the callback/token
4. Return the response once auth completes or times out

If the auth flow requires user interaction in the browser, the backend should block until completion (with a reasonable timeout, e.g. 120 seconds).

```json
{
  "valid": true,
  "subscriptions": [...]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `valid` | `boolean` | Whether authentication succeeded. |
| `error` | `string?` | Human-readable error message when `valid` is `false`. |
| `subscriptions` | `SubscriptionItem[]` | List of discoverable accounts/subscriptions/projects/servers. Empty array if validation failed. |

**SubscriptionItem**:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier (AWS account ID, Azure subscription ID, GCP project ID, server hostname). |
| `name` | `string` | Display name shown in the UI. For AWS: include the account number, e.g. `"Production – Core Platform (112233445566)"`. For Azure: include region if relevant. For GCP: project ID string. For Microsoft: FQDN of the server. |

**Subscription terminology per provider**:
- AWS → "Accounts"
- Azure → "Subscriptions"
- GCP → "Projects"
- Microsoft → "Servers"

---

### 3. Start Scan

Initiates an asynchronous scan across one or more providers. Returns immediately with a scan ID for polling.

```
POST /api/v1/scan
```

**Request body**:

```json
{
  "providers": [
    {
      "provider": "aws",
      "authMethod": "sso",
      "credentials": {
        "ssoStartUrl": "https://my-org.awsapps.com/start",
        "ssoRegion": "us-east-1"
      },
      "subscriptions": ["aws-001", "aws-002", "aws-004"],
      "selectionMode": "include"
    },
    {
      "provider": "azure",
      "authMethod": "service-principal",
      "credentials": {
        "tenantId": "abc-123",
        "clientId": "def-456",
        "clientSecret": "***"
      },
      "subscriptions": ["az-003", "az-010"],
      "selectionMode": "exclude"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `providers` | `ProviderScanConfig[]` | Array of provider scan configurations. |

**ProviderScanConfig**:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | `"aws"`, `"azure"`, `"gcp"`, `"microsoft"` |
| `authMethod` | `string` | Same auth method ID used in validation. |
| `credentials` | `Record<string, string>` | Same credentials used in validation. |
| `subscriptions` | `string[]` | Array of subscription/account IDs selected (or excluded) by the user. |
| `selectionMode` | `"include" \| "exclude"` | `"include"` = scan ONLY the listed IDs. `"exclude"` = scan ALL discovered subscriptions EXCEPT the listed IDs. |

**Response** `200 OK`:

```json
{
  "scanId": "scan-a1b2c3d4"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `scanId` | `string` | Unique identifier for this scan. Used to poll status and retrieve results. |

**Implementation notes**:
- The Go backend MUST scan providers in **parallel** (not sequentially).
- The backend should cache the authenticated sessions from the validate step so credentials don't need to be re-authenticated.
- The `selectionMode` + `subscriptions` combination determines what gets scanned:
  - `include` + `["a", "b"]` → scan only a and b
  - `exclude` + `["c"]` → scan everything discovered EXCEPT c
  - `include` + `[]` → scan nothing (edge case, frontend prevents this)
  - `exclude` + `[]` → scan everything

---

### 4. Poll Scan Status

The frontend polls this every 1.5 seconds to update the progress UI.

```
GET /api/v1/scan/{scanId}/status
```

**Path parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `scanId` | `string` | The scan ID returned by the start scan endpoint. |

**Response** `200 OK`:

```json
{
  "scanId": "scan-a1b2c3d4",
  "overallProgress": 67,
  "status": "running",
  "providers": [
    {
      "provider": "aws",
      "progress": 100,
      "status": "complete",
      "itemsFound": 27
    },
    {
      "provider": "azure",
      "progress": 45,
      "status": "scanning",
      "itemsFound": 12
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `scanId` | `string` | Echo of the scan ID. |
| `overallProgress` | `number` (0-100) | Weighted average of all provider progress values. |
| `status` | `"running" \| "complete" \| "error"` | Overall scan status. `"complete"` only when ALL providers finish. |
| `providers` | `ProviderScanStatus[]` | Per-provider progress breakdown. |

**ProviderScanStatus**:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | Provider ID. |
| `progress` | `number` (0-100) | Percentage complete for this provider. |
| `status` | `"pending" \| "scanning" \| "complete" \| "error"` | Current state. |
| `error` | `string?` | Error message if status is `"error"`. |
| `itemsFound` | `number?` | Running count of line items discovered so far. |

**Frontend behavior**:
- Polls every 1500ms until `status` is `"complete"` or `"error"`.
- Updates individual provider progress bars in real-time.
- On `"complete"` → stops polling, fetches full results.
- On `"error"` → stops polling, shows error with retry option.

---

### 5. Get Scan Results

Returns the complete scan findings after the scan is complete.

```
GET /api/v1/scan/{scanId}/results
```

**Path parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `scanId` | `string` | The scan ID. |

**Response** `200 OK`:

```json
{
  "scanId": "scan-a1b2c3d4",
  "completedAt": "2026-03-08T14:32:00Z",
  "totalManagementTokens": 2847,
  "findings": [
    {
      "provider": "aws",
      "source": "Production – Core Platform (112233445566)",
      "category": "DDI Object",
      "item": "VPCs",
      "count": 6,
      "tokensPerUnit": 25,
      "managementTokens": 1
    },
    {
      "provider": "aws",
      "source": "Production – Core Platform (112233445566)",
      "category": "DDI Object",
      "item": "Route53 Record Sets",
      "count": 1842,
      "tokensPerUnit": 25,
      "managementTokens": 74
    },
    {
      "provider": "azure",
      "source": "Enterprise Production – East US",
      "category": "Active IP",
      "item": "VM IPs",
      "count": 1890,
      "tokensPerUnit": 13,
      "managementTokens": 146
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `scanId` | `string` | Echo of the scan ID. |
| `completedAt` | `string` (ISO 8601) | Timestamp when the scan finished. |
| `totalManagementTokens` | `number` | Pre-calculated sum of all `managementTokens` values. |
| `findings` | `FindingRow[]` | Array of all discovered items across all providers. |

**FindingRow**:

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | `"aws"`, `"azure"`, `"gcp"`, `"microsoft"` |
| `source` | `string` | The account/subscription/project/server name this item was discovered in. MUST match the `name` field from the subscription list returned during validation. |
| `category` | `string` | `"DDI Object"`, `"Active IP"`, or `"Asset"` — one of exactly three values. |
| `item` | `string` | The specific resource type label (see Item Labels below). |
| `count` | `number` | Number of objects discovered (non-negative integer). |
| `tokensPerUnit` | `number` | The denominator for token calculation: `25` for DDI Object, `13` for Active IP, `3` for Asset. |
| `managementTokens` | `number` | `ceil(count / tokensPerUnit)` — the computed management tokens for this row. |

---

## Token Calculation Rules

The Management Token formula is:

```
managementTokens = ceil(count / tokensPerUnit)
```

| Category | tokensPerUnit | Meaning |
|----------|---------------|---------|
| DDI Object | 25 | 1 Management Token per 25 DDI Objects |
| Active IP | 13 | 1 Management Token per 13 Active IPs |
| Asset | 3 | 1 Management Token per 3 Assets |

The Go backend MUST calculate `managementTokens` server-side using `math.Ceil(float64(count) / float64(tokensPerUnit))`. The frontend will display the value as-is.

---

## Item Labels by Provider and Category

The Go scanner MUST emit these exact string labels in the `item` field. The frontend displays them verbatim. Labels are derived from the [cloud-bucket-crosswalk.md](/src/imports/cloud-bucket-crosswalk.md) reference.

### AWS

**DDI Objects** (`category: "DDI Object"`, `tokensPerUnit: 25`):
- `VPCs`
- `VPC CIDR Blocks`
- `Subnets`
- `Internet Gateways`
- `Transit Gateways`
- `Elastic IP Addresses`
- `Route Tables`
- `VPN Connections`
- `VPN Gateways`
- `Customer Gateways`
- `Resolver Endpoints`
- `Resolver Rules`
- `Resolver Rule Associations`
- `IPAMs`
- `IPAM Scopes`
- `IPAM Pools`
- `IPAM Resource Discoveries`
- `IPAM Resource Discovery Associations`
- `Route53 Hosted Zones`
- `Route53 Record Sets`
- `Route53 Health Checks`
- `Route53 Traffic Policies`
- `Route53 Traffic Policy Instances`
- `Route53 Query Logging Configs`
- `Direct Connect Gateways`

**Active IPs** (`category: "Active IP"`, `tokensPerUnit: 13`):
- `EC2 Instance IPs`

**Assets** (`category: "Asset"`, `tokensPerUnit: 3`):
- `NAT Gateways`
- `Network Interfaces`
- `Elastic LoadBalancers`
- `Listeners`
- `Target Groups`

### Azure

**DDI Objects** (`category: "DDI Object"`, `tokensPerUnit: 25`):
- `vNets`
- `Subnets`
- `Network Route Tables`
- `Azure DNS Zones`
- `Azure Private DNS Zones`
- `DNS Records (Supported Types)`
- `DNS Records (Unsupported Types)`

> Note: `Virtual Network` and `Virtual Network Subnets` from the crosswalk are the same underlying objects as `vNets` and `Subnets`. Do NOT double-count. Emit only `vNets` and `Subnets`.

**Active IPs** (`category: "Active IP"`, `tokensPerUnit: 13`):
- `VM IPs`
- `Load Balancer IPs`
- `vNet Gateway IPs`
- `Private Link Services IPs`
- `Private Endpoints IPs`

**Assets** (`category: "Asset"`, `tokensPerUnit: 3`):
- `Network Interfaces`
- `Networking Load Balancers`
- `Network VNET Gateways`
- `Private Link Services`
- `Private Endpoints`
- `Network NAT Gateways`
- `Network Application Gateways`
- `Network Azure Firewalls`
- `Virtual Machines`
- `Virtual Machine Scale Sets`

### GCP

**DDI Objects** (`category: "DDI Object"`, `tokensPerUnit: 25`):
- `VPC Networks`
- `Primary Subnetworks`
- `Secondary Subnetworks`
- `Compute Addresses`
- `Compute Routers`
- `Compute Router NAT Mapping Infos`
- `Compute VPN Gateways`
- `Compute Target VPN Gateways`
- `VPN Tunnels`
- `GKE Control Plane IP Ranges`
- `GKE Pod IP Ranges`
- `GKE Service IP Ranges`
- `Cloud DNS Zones`
- `Cloud DNS Records (Supported Types)`
- `Cloud DNS Records (Unsupported Types)`

**Active IPs** (`category: "Active IP"`, `tokensPerUnit: 13`):
- `Compute Instance IPs`
- `Load Balancer IPs`
- `GKE Node IPs`
- `GKE Pod IPs`
- `GKE Service IPs`

**Assets** (`category: "Asset"`, `tokensPerUnit: 3`):
- *(none — the GCP collector does not emit asset rows)*

### Microsoft DHCP/DNS

**DDI Objects** (`category: "DDI Object"`, `tokensPerUnit: 25`):
- `DNS Forward Zones`
- `DNS Reverse Zones`
- `DNS Resource Records`
- `DNS Views`
- `DHCP Scopes`
- `DHCP Reservations`
- `IP Subnets`
- `Address Blocks`

**Active IPs** (`category: "Active IP"`, `tokensPerUnit: 13`):
- `DHCP Active Leases`
- `Static IP Assignments`

**Assets** (`category: "Asset"`, `tokensPerUnit: 3`):
- `Physical Appliances`
- `Virtual Appliances`
- `HA Nodes`

---

## Go Implementation Guide

### Project Structure (recommended)

```
ddi-scanner/
├── main.go                    # Entry point, flag parsing, starts HTTP server
├── server/
│   ├── server.go              # HTTP router, static file serving, middleware
│   ├── health.go              # GET /api/v1/health
│   ├── validate.go            # POST /api/v1/providers/{provider}/validate
│   ├── scan.go                # POST /api/v1/scan, GET .../status, GET .../results
│   └── types.go               # Shared request/response structs
├── scanner/
│   ├── scanner.go             # Scanner interface + orchestrator
│   ├── aws.go                 # AWS collector (Route53, VPC, EC2, ELB, IPAM)
│   ├── azure.go               # Azure collector (DNS, vNet, VM, LB, etc.)
│   ├── gcp.go                 # GCP collector (Cloud DNS, VPC, Compute, GKE)
│   └── microsoft.go           # MS DHCP/DNS collector (WMI/PowerShell)
├── token/
│   └── calculator.go          # Token rate constants + ceil calculation
├── dist/                      # Vite build output (embedded)
│   ├── index.html
│   └── assets/
├── embed.go                   # //go:embed dist/*
├── go.mod
└── go.sum
```

### Embedding the Frontend

```go
package main

import "embed"

//go:embed dist/*
var staticFiles embed.FS

// In your HTTP handler:
// fs := http.FileServer(http.FS(subFS))
// where subFS, _ = fs.Sub(staticFiles, "dist")
```

### Build & Run

```bash
# 1. Build frontend
cd ui/
npm ci
npm run build
cp -r dist/ ../dist/

# 2. Build Go binary
cd ..
go build -o ddi-scanner.exe .

# 3. Run
./ddi-scanner.exe --port 8080
```

The binary should:
- Parse `--port` flag (default `8080`)
- Serve the embedded SPA on `/`
- Serve the API on `/api/v1/*`
- Auto-open the user's default browser to `http://localhost:{port}`
- Log to stdout with structured logging

### Scan Lifecycle

```
Frontend                          Go Backend
   │                                  │
   │  POST /api/v1/scan               │
   │──────────────────────────────────>│
   │  { scanId: "abc123" }            │  ← returns immediately
   │<──────────────────────────────────│
   │                                  │  starts goroutines per provider
   │  GET /scan/abc123/status         │
   │──────────────────────────────────>│
   │  { status: "running", ... }      │  ← returns current progress
   │<──────────────────────────────────│
   │         ... polls every 1.5s ... │
   │  GET /scan/abc123/status         │
   │──────────────────────────────────>│
   │  { status: "complete" }          │
   │<──────────────────────────────────│
   │                                  │
   │  GET /scan/abc123/results        │
   │──────────────────────────────────>│
   │  { findings: [...] }             │  ← full results
   │<──────────────────────────────────│
```

### Concurrency Model

- Each provider scans in its own goroutine
- Progress is tracked per-provider in a thread-safe map (`sync.RWMutex`)
- The scan store (in-memory map of `scanId → ScanState`) should support concurrent reads
- Scan results are kept in memory (no persistence needed — this is a single-use assessment tool)
- Consider adding a TTL/cleanup for old scans (e.g. 1 hour)

---

## Frontend ↔ Backend Contract Summary

| Step | UI Action | API Call | Fallback (Demo Mode) |
|------|-----------|----------|---------------------|
| Health | Page load + every 8s | `GET /health` | Timeout → demo mode |
| Validate | "Validate & Connect" button | `POST /providers/{p}/validate` | 1.2s delay → mock subscriptions |
| Start Scan | "Next" from Step 3 | `POST /scan` | Mock parallel progress timers |
| Poll Status | Auto (every 1.5s) | `GET /scan/{id}/status` | N/A (mock handles internally) |
| Get Results | When status = complete | `GET /scan/{id}/results` | Mock findings from crosswalk data |
| Export CSV | "Download CSV" button | *(client-side only)* | Same |
| Export Excel | "Download Excel" button | *(client-side only)* | Same |
