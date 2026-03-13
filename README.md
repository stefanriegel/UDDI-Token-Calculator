# UDDI Token Calculator

Estimates Infoblox Universal DDI management tokens from cloud infrastructure (AWS, Azure, GCP), Active Directory, and NIOS Grid backups.

Single self-contained binary with embedded web UI. Launch it, scan your environment, get a token estimate -- no installation required.

<!-- TODO: Add screenshot of the web UI -->

## Features

- Single binary with embedded web UI -- auto-opens browser on launch
- AWS discovery: VPCs, subnets, Route53 zones/records, EC2 instances, load balancers
- Azure discovery: VNets, subnets, DNS zones/records, VMs, load balancers, gateways
- GCP discovery: VPC networks, subnets, Cloud DNS zones/records, compute instances
- Active Directory discovery via WinRM: DNS zones/records, DHCP scopes/leases, user accounts
- NIOS Grid backup analysis: upload `.tar.gz`/`.tgz`/`.bak` backups, per-member DDI object counts
- SSO/browser-OAuth for AWS and Azure (alongside static credentials)
- Token calculation: DDI Objects (25/token), Active IPs (13/token), Managed Assets (3/token)
- Excel export (`.xlsx`) with per-provider breakdown and error traceability
- Migration Planner with scenario comparison (NIOS)
- Credentials never written to disk -- in-memory only

## Supported Platforms

| OS | Architecture | Binary |
|----|-------------|--------|
| Windows | amd64 | `uddi-token-calculator_windows_amd64` |
| Windows | arm64 | `uddi-token-calculator_windows_arm64` |
| macOS | amd64 (Intel) | `uddi-token-calculator_darwin_amd64` |
| macOS | arm64 (Apple Silicon) | `uddi-token-calculator_darwin_arm64` |
| Linux | amd64 | `uddi-token-calculator_linux_amd64` |
| Linux | arm64 | `uddi-token-calculator_linux_arm64` |

## Quick Start

1. Download the latest release for your platform from the [Releases](../../releases) page
2. Run the binary:
   ```
   ./uddi-token-calculator
   ```
   On Windows:
   ```
   uddi-token-calculator.exe
   ```
3. The web UI opens automatically in your default browser
4. Select a provider, enter credentials, and start scanning
5. Review token estimates and export to Excel

**Note for Windows:** The binary is currently unsigned. Windows SmartScreen may show a warning -- click "More info" then "Run anyway".

## Usage

The web UI guides you through a wizard with the following steps:

1. **Provider Selection** -- Choose one or more providers to scan (AWS, Azure, GCP, Active Directory, NIOS)
2. **Credentials** -- Enter credentials for each selected provider. For NIOS, upload a Grid backup file (`.tar.gz`, `.tgz`, or `.bak`) instead of entering credentials, then select the members to analyze.
3. **Scan** -- The scanner discovers resources across all selected providers concurrently
4. **Results** -- Review discovered resources, token estimates, and per-provider breakdowns
5. **Export** -- Download an Excel report with full details and error traceability

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

## Building from Source

```bash
git clone https://github.com/infoblox/uddi-go-token-calculator.git
cd uddi-go-token-calculator

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

## License

All rights reserved. This software is proprietary.
