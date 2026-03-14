# UDDI Token Calculator

![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)
![License](https://img.shields.io/badge/License-Proprietary-red)
![Platforms](https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![Providers](https://img.shields.io/badge/Providers-8-green)

*A pre-sales tool for estimating Infoblox Universal DDI management tokens from existing infrastructure.*

Estimates Infoblox Universal DDI management tokens from cloud infrastructure (AWS, Azure, GCP), Active Directory, NIOS Grid backups, NIOS WAPI, Bluecat Address Manager, and EfficientIP SOLIDserver.

Single self-contained binary with embedded web UI. Launch it, scan your environment, get a token estimate -- no installation required.

---

## Features

- **Embedded Web UI** -- Single binary with auto-browser launch, no installation needed
- **AWS Discovery** -- VPCs, subnets, Route53 zones/records, EC2 instances, load balancers
- **Azure Discovery** -- VNets, subnets, DNS zones/records, VMs, load balancers, gateways
- **GCP Discovery** -- VPC networks, subnets, Cloud DNS zones/records, compute instances
- **Active Directory Discovery** -- DNS zones/records, DHCP scopes/leases, user accounts via WinRM
- **NIOS Grid Backup Analysis** -- Upload `.tar.gz`/`.tgz`/`.bak` backups, per-member DDI object counts
- **NIOS WAPI Discovery** -- Live REST API connection to Grid Manager, auto-detects WAPI version, capacity report
- **Bluecat Discovery** -- DNS views/zones/records, IPAM blocks/networks/addresses, DHCP ranges via REST API
- **EfficientIP Discovery** -- DNS views/zones/records, IPAM sites/subnets/pools/addresses, DHCP scopes/ranges via REST API
- **SSO/Browser-OAuth** -- For AWS and Azure (alongside static credentials)
- **Token Calculation** -- DDI Objects (25/token), Active IPs (13/token), Managed Assets (3/token)
- **Excel Export** -- `.xlsx` with per-provider breakdown and error traceability
- **Migration Planner** -- Scenario comparison for NIOS migrations
- **Security First** -- Credentials never written to disk, in-memory only

---

## Providers at a Glance

| Provider | Auth Methods | What It Discovers |
|----------|-------------|-------------------|
| AWS | Access Key / Secret Key, SSO | VPCs, subnets, Route53, EC2, load balancers |
| Azure | Client Secret, Browser OAuth | VNets, subnets, DNS, VMs, load balancers, gateways |
| GCP | Service Account JSON | VPC networks, subnets, Cloud DNS, compute instances |
| Active Directory | WinRM (NTLM) | DNS zones/records, DHCP scopes/leases, users |
| NIOS Grid | Backup file upload | DNS, DHCP, IPAM, DTC objects per member |
| NIOS WAPI | Username / Password | Capacity report, DNS/DHCP/IPAM object totals per member |
| Bluecat Address Manager | Username / Password | DNS views/zones/records, IPAM blocks/networks/addresses, DHCP ranges |
| EfficientIP SOLIDserver | Username / Password | DNS views/zones/records, IPAM sites/subnets/pools/addresses, DHCP scopes/ranges |

## Supported Platforms

| OS | Architecture | Binary |
|----|-------------|--------|
| Windows | amd64 | `uddi-token-calculator_windows_amd64` |
| Windows | arm64 | `uddi-token-calculator_windows_arm64` |
| macOS | amd64 (Intel) | `uddi-token-calculator_darwin_amd64` |
| macOS | arm64 (Apple Silicon) | `uddi-token-calculator_darwin_arm64` |
| Linux | amd64 | `uddi-token-calculator_linux_amd64` |
| Linux | arm64 | `uddi-token-calculator_linux_arm64` |

---

## Quick Start

### Install via Homebrew (macOS / Linux)

```bash
brew tap stefanriegel/tap
brew install uddi-token-calculator
```

### Install via shell script (macOS / Linux)

```bash
curl -sL https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.sh | sh
```

Or install to a custom directory:

```bash
INSTALL_DIR=~/.local/bin curl -sL https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.sh | sh
```

### Manual download

Download the latest release for your platform from the [Releases](https://github.com/stefanriegel/UDDI-Token-Calculator/releases/latest) page.

### Run

```bash
uddi-token-calculator
```

On Windows:

```
uddi-token-calculator.exe
```

The web UI opens automatically in your default browser. Select a provider, enter credentials, start scanning, and review token estimates.

**Note for Windows:** The binary is currently unsigned. Windows SmartScreen may show a warning -- click "More info" then "Run anyway".

## Usage

The web UI guides you through a wizard with the following steps:

1. **Provider Selection** -- Choose one or more providers to scan (AWS, Azure, GCP, Active Directory, NIOS Grid/WAPI, Bluecat, EfficientIP)
2. **Credentials** -- Enter credentials for each selected provider. For NIOS Grid, upload a backup file (`.tar.gz`, `.tgz`, or `.bak`) instead of entering credentials, then select the members to analyze. For NIOS WAPI, Bluecat, and EfficientIP, provide the server URL and username/password.
3. **Scan** -- The scanner discovers resources across all selected providers concurrently
4. **Results** -- Review discovered resources, token estimates, and per-provider breakdowns
5. **Export** -- Download an Excel report with full details and error traceability

---

## Supported Providers

### AWS

Authenticates via Access Key / Secret Key or SSO (browser-based login). Discovers VPCs, subnets, Route53 hosted zones and records, EC2 instances, and load balancers across all selected regions.

### Azure

Authenticates via Client ID / Client Secret / Tenant ID or browser-based OAuth. Discovers VNets, subnets, DNS zones and records, virtual machines, load balancers, and application gateways across all selected subscriptions.

### GCP

Authenticates via a Service Account JSON key file. Discovers VPC networks, subnets, Cloud DNS managed zones and records, and compute instances across all selected projects.

### Active Directory

Connects via WinRM using NTLM authentication. Discovers DNS zones and records, DHCP scopes and leases, and user accounts. Supports scanning multiple domain controllers concurrently with cross-DC deduplication.

### NIOS Grid

Accepts a Grid backup file (`.tar.gz`, `.tgz`, or `.bak`, up to 500 MB). Parses the `onedb.xml` database to count DDI objects per grid member, including DNS zones/records, DHCP ranges/leases, IPAM networks, and DTC objects. Provides per-member server metrics (QPS, LPS, object counts) for migration planning.

### NIOS WAPI

Connects directly to a NIOS Grid Manager via REST API. Auto-detects the supported WAPI version (probes from v2.13.7 down to v2.9.13), fetches the capacity report, and produces per-member DDI object counts. Authenticates with username/password. Supports optional TLS certificate verification skip for self-signed certificates.

### Bluecat Address Manager

Connects via REST API v2 (preferred) with automatic fallback to legacy v1 API. Discovers DNS views, zones, and records (A, AAAA, CNAME, MX, TXT, SRV, PTR, NS, SOA, and more), IPAM blocks, networks, and addresses (IPv4 and IPv6), and DHCP ranges. Authenticates with username/password. Supports optional TLS certificate verification skip.

### EfficientIP SOLIDserver

Connects via REST API using HTTP Basic authentication (preferred) with fallback to native X-IPM header authentication. Discovers DNS views, zones, and records, IPAM sites, subnets, pools, and addresses, and DHCP scopes and ranges. Supports optional site ID filtering and TLS certificate verification skip. Authenticates with username/password.

---

## Building from Source

```bash
git clone https://github.com/stefanriegel/UDDI-Token-Calculator.git
cd UDDI-Token-Calculator

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Build binary
CGO_ENABLED=0 go build -ldflags="-s -w" -o uddi-token-calculator .
```

Requires Go 1.24+ and Node.js 18+.

## Release Verification

Releases include GPG-signed checksums. To verify a downloaded binary:

```bash
# Verify the checksum signature
gpg --verify checksums.txt.sig checksums.txt

# Verify the binary checksum
sha256sum --check checksums.txt
```

---

## License

All rights reserved. This software is proprietary.
