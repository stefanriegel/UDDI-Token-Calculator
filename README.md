# UDDI Token Calculator

![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go&logoColor=white)
![License](https://img.shields.io/badge/License-Proprietary-red)
![Platforms](https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-blue)

Estimates Infoblox Universal DDI management tokens from existing infrastructure. Single self-contained binary with embedded web UI.

## Quick Start

### Homebrew (macOS)

```bash
brew tap stefanriegel/tap
brew install uddi-token-calculator
```

### Shell Script (macOS)

```bash
curl -sL https://raw.githubusercontent.com/stefanriegel/UDDI-Token-Calculator/main/scripts/install.sh | sh
```

### Manual Download

Download the latest release from the [Releases](https://github.com/stefanriegel/UDDI-Token-Calculator/releases/latest) page.

| OS | Architecture | Format |
|----|-------------|--------|
| macOS | arm64 (Apple Silicon) | Binary / Homebrew |
| Windows | amd64 | Binary |
| Linux | amd64 (WSL, native) | Binary |

### Run

```bash
uddi-token-calculator
```

The web UI opens automatically at `127.0.0.1`. Select providers, enter credentials, scan, and review token estimates.

## Windows Security Note

The binary is not code-signed, so Windows SmartScreen and antivirus may block it on first run. Here are three ways to handle this:

**Option 1: SmartScreen dialog (simplest)**

When SmartScreen shows "Windows protected your PC", click **More info** → **Run anyway**.

**Option 2: Unblock via PowerShell**

```powershell
Unblock-File .\uddi-token-calculator.exe
.\uddi-token-calculator.exe
```

**Option 3: Run via WSL (advanced)**

If you have WSL installed, you can run the Linux binary directly:

```bash
# Download the Linux binary from GitHub Releases
curl -sL https://github.com/stefanriegel/UDDI-Token-Calculator/releases/latest/download/uddi-token-calculator_linux_amd64 -o uddi-token-calculator
chmod +x uddi-token-calculator
./uddi-token-calculator
```

The web UI opens in your Windows browser at `127.0.0.1` -- WSL shares the network with Windows.

## Supported Providers

| Provider | Auth | Discovers |
|----------|------|-----------|
| **AWS** | Access Key or SSO | VPCs, subnets, Route53, EC2, load balancers |
| **Azure** | Client Secret or Browser OAuth | VNets, subnets, DNS, VMs, load balancers, gateways |
| **GCP** | Service Account JSON | VPC networks, subnets, Cloud DNS, compute instances |
| **Active Directory** | WinRM (NTLM) | DNS zones/records, DHCP scopes/leases, users |
| **NIOS Grid** | Backup upload (.tar.gz/.tgz/.bak) | Per-member DNS, DHCP, IPAM, DTC objects |
| **NIOS WAPI** | Username / Password | Capacity report, per-member DDI totals |
| **Bluecat** | Username / Password | DNS views/zones/records, IPAM blocks/networks, DHCP ranges |
| **EfficientIP** | Username / Password | DNS views/zones/records, IPAM subnets/pools, DHCP scopes |

## Token Calculation

Resources are grouped into three categories:

| Category | Ratio |
|----------|-------|
| DDI Objects | 25 objects per token |
| Active IPs | 13 IPs per token |
| Managed Assets | 3 assets per token |

The grand total is the **maximum** across all three categories.

## Additional Features

- **Excel Export** -- `.xlsx` with summary, per-provider breakdown, and error traceability
- **NIOS Migration Planner** -- Scenario comparison for NIOS-to-UDDI migrations with per-member metrics
- **Multi-Provider Scanning** -- Scan multiple providers concurrently in a single session
- **Security** -- Credentials stay in-memory only, never written to disk

## Building from Source

```bash
git clone https://github.com/stefanriegel/UDDI-Token-Calculator.git
cd UDDI-Token-Calculator
cd frontend && npm install && npm run build && cd ..
CGO_ENABLED=0 go build -ldflags="-s -w" -o uddi-token-calculator .
```

Requires Go 1.24+ and Node.js 18+.

## License

All rights reserved. This software is proprietary.
