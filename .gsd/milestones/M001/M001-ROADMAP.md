# M001: MVP (Phases 1-8) — SHIPPED 2026-03-09

**Vision:** Build a single Go binary that estimates Infoblox Universal DDI management tokens by scanning AWS, Azure, GCP, and Active Directory — with an embedded React web UI that auto-opens in the browser, credential entry via the UI only, and Excel export.

## Success Criteria


## Slices

- [x] **S01: Foundation** `risk:medium` `depends:[]`
  > After this: Go project scaffold with chi router, embed.FS, and auto-open browser works
- [x] **S02: Core UI + Token Calculator** `risk:medium` `depends:[S01]`
  > After this: React wizard renders provider selection, credential entry, scan progress, and token calculation
- [x] **S03: AWS Discovery** `risk:medium` `depends:[S02]`
  > After this: AWS VPCs, subnets, Route53, EC2, and load balancers are discovered and counted
- [x] **S04: Azure Discovery** `risk:medium` `depends:[S03]`
  > After this: Azure VNets, DNS zones, VMs, load balancers, and gateways are discovered and counted
- [x] **S05: GCP Discovery** `risk:medium` `depends:[S04]`
  > After this: GCP VPC networks, Cloud DNS, and compute instances are discovered and counted
- [x] **S06: AD / WinRM Discovery** `risk:medium` `depends:[S05]`
  > After this: AD DNS zones/records, DHCP scopes/leases via WinRM+NTLM are discovered and counted
- [x] **S07: Excel Export** `risk:medium` `depends:[S06]`
  > After this: Streaming .xlsx export with per-provider breakdown and error traceability works
- [x] **S08: CI/CD and Distribution** `risk:medium` `depends:[S07]`
  > After this: GitHub Actions builds Windows .exe via GoReleaser OSS v2
