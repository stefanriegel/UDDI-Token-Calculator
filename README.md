# UDDI Token Calculator

![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)
![License](https://img.shields.io/badge/License-Proprietary-red)
![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-blue)

Estimates Infoblox Universal DDI management tokens by scanning your existing infrastructure — cloud providers, Active Directory, NIOS Grids, and third-party DDI systems. Single self-contained binary with an embedded web UI. No runtime, no installer, no setup.

## Highlights

- 🔍 **8 providers** — AWS, Azure, GCP, Active Directory, NIOS Grid, NIOS WAPI, Bluecat, EfficientIP
- 🏢 **Enterprise-scale** — Multi-account AWS (Organizations), multi-subscription Azure, multi-project GCP with parallel scanning
- 📊 **Migration planning** — NIOS-X tier recommendations, 3-scenario migration planner (Current / Hybrid / Full)
- 📈 **Per-server sizing** — Per-DC NIOS-X tier calculation for AD with DHCP +20% overhead
- 🔐 **9 auth methods** — Access keys, SSO, CLI profiles, service principals, device code, Kerberos, and more
- 📁 **Excel export** — `.xlsx` with summary, per-provider breakdown, migration planner, and error traceability
- 🛡️ **Security** — Credentials stay in-memory only, never written to disk

## Installation

### Windows

<details open>
<summary><strong>PowerShell (recommended)</strong></summary>

```powershell
irm https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.ps1 | iex
```

</details>

<details>
<summary><strong>Manual download</strong></summary>

1. Download `uddi-token-calculator_windows_amd64.exe` from the [latest release](https://github.com/stefanriegel/UDDI-Token-Calculator/releases/latest)
2. Unblock the file: right-click → Properties → check **Unblock** → OK
3. Double-click or run from terminal

</details>

### macOS

<details open>
<summary><strong>Homebrew (recommended)</strong></summary>

```bash
brew tap stefanriegel/tap
brew install uddi-token-calculator
```

</details>

<details>
<summary><strong>Shell script</strong></summary>

```bash
curl -sL https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.sh | sh
```

</details>

### Linux

```bash
curl -sL https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.sh | sh
```

### Dev Channel

Pre-release builds are available for testing new features before stable release.

```powershell
# Windows
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.ps1))) -Channel dev
```

```bash
# macOS / Linux
curl -sL https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.sh | sh -s -- --channel dev
```

## Usage

```bash
uddi-token-calculator
```

The web UI opens automatically in your default browser. From there:

1. **Select providers** — Choose which infrastructure to scan
2. **Enter credentials** — Authenticate to each provider (credentials stay in-memory)
3. **Configure sources** — Select accounts, subscriptions, Grid Members, or DCs to scan
4. **Scan** — The tool discovers and counts resources across all selected providers
5. **Review results** — Token estimates, migration planner, Excel export

## Windows Security Note

The binary is not code-signed, so Windows SmartScreen may show a warning on first run.

| Method | Steps |
|--------|-------|
| **SmartScreen dialog** | Click **More info** → **Run anyway** |
| **PowerShell unblock** | `Unblock-File .\uddi-token-calculator.exe` |
| **Installer script** | Already handled — the install script calls `Unblock-File` automatically |

## Supported Providers

| Provider | Auth Methods | Discovers |
|----------|-------------|-----------|
| **AWS** | Access Key, SSO, CLI Profile, Assume Role, Organizations | VPCs, subnets, Route53 zones/records (per-type), EC2, ELBs, NICs, NAT/IGW/TGW, IPAM, VPN, resolver endpoints |
| **Azure** | Service Principal, Browser SSO, CLI (`az login`), Certificate, Device Code | VNets, subnets, DNS zones/records (per-type), VMs, LBs, App Gateways, public IPs, firewalls, private endpoints, VNet gateways |
| **GCP** | Service Account JSON, ADC, Browser OAuth, Workload Identity Federation | VPCs, subnets, Cloud DNS zones/records (per-type), compute instances, LBs, addresses, firewalls, routers, VPN gateways/tunnels, GKE CIDRs |
| **Active Directory** | WinRM (NTLM), WinRM (Kerberos), HTTPS | DNS zones/records, DHCP scopes/leases/reservations, users, computers, static IPs |
| **NIOS Grid** | Backup upload (`.tar.gz` / `.tgz` / `.bak`) | Per-member DNS, DHCP, IPAM, DTC objects, QPS/LPS |
| **NIOS WAPI** | Username / Password | Capacity report, per-member DDI totals |
| **Bluecat** | Username / Password (v2 API with v1 fallback) | DNS views/zones/records, IPAM blocks/networks/addresses, DHCP ranges |
| **EfficientIP** | Username / Password (Basic + native fallback) | DNS views/zones/records, IPAM sites/subnets/pools, DHCP scopes/ranges |

## Token Calculation

Resources are grouped into three categories:

| Category | Ratio | Examples |
|----------|-------|---------|
| **DDI Objects** | 25 objects per token | DNS zones, DNS records, DHCP scopes, IP networks |
| **Active IPs** | 13 IPs per token | DHCP leases, static host IPs, NIC IPs |
| **Managed Assets** | 3 assets per token | VMs, load balancers, Grid Members, HA pairs |

The grand total is the **maximum** across all three categories.

## Features

### Migration Planning

- **NIOS Migration Planner** — 3-scenario comparison (Current / Hybrid / Full UDDI) with per-member server token calculation
- **AD Migration Planner** — Per-DC NIOS-X tier recommendations (2XS–XL) with DHCP +20% overhead, event log QPS/LPS extraction
- **Server Token Calculator** — Per-member form factor selection (NIOS-X on-prem vs XaaS) with tier-based token math
- **XaaS Consolidation** — Bin-packing across S/M/L/XL tiers with connection limits

### Enterprise Scanning

- **Multi-account AWS** — Organizations discovery + AssumeRole fan-out with per-account progress
- **Multi-subscription Azure** — Parallel subscription scanning with per-subscription progress
- **Multi-project GCP** — Org/folder traversal + parallel project scanning
- **Retry & backoff** — Exponential backoff for API throttling across all cloud providers
- **Checkpoint/resume** — Resume interrupted scans from the last completed unit

### Results & Export

- **Top Consumer Cards** — DNS, DHCP, IP/Network breakdowns (expandable, top 5 per category)
- **Per-type DNS records** — A, AAAA, CNAME, MX, TXT, SRV, and more — across all cloud providers
- **Excel export** — `.xlsx` with summary, per-provider sheets, migration planner, and error traceability
- **Knowledge Worker count** — AD user account sizing metric
- **Computer inventory & static IPs** — Managed asset and active IP counts from AD

## Building from Source

<details>
<summary>Development setup</summary>

**Prerequisites:** Go 1.24+, Node.js 18+, pnpm

```bash
git clone https://github.com/stefanriegel/UDDI-Token-Calculator.git
cd UDDI-Token-Calculator

# Build frontend (required — Go embeds frontend/dist at compile time)
cd frontend && pnpm install && pnpm build && cd ..

# Build binary
CGO_ENABLED=0 go build -ldflags="-s -w" -o uddi-token-calculator .
```

**Windows build** (requires mingw-w64 for SSPI support):

```bash
CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc GOOS=windows GOARCH=amd64 \
  go build -ldflags="-s -w" -o uddi-token-calculator.exe .
```

**Run tests:**

```bash
go test ./... -count=1
```

</details>

## License

All rights reserved. This software is proprietary.
