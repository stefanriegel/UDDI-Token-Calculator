# AWS, Azure, and GCP Bucket Crosswalk

This file is derived only from `cloud-object-counter-master`.

This repo is the collector/reference implementation, but it does **not** keep a first-class
`DDI Objects` / `Active IP` / `Assets` mapping table. The grouping below is therefore the
working crosswalk from the collector's own emitted labels and categories:

- `Active IP` = labels emitted under `Address Records`
- `DDI Objects` = labels emitted under `DNS`, `DNS Record Types`, and `IPAM`, plus the
  network-space / address-management objects that this collector treats as core inventory
- `Assets` = concrete compute or network service/appliance objects emitted outside the
  DDI/IP groups
- Explicit `Discovered Only` rows and placeholder rows such as `Metrics` are not counted here
- If the same underlying object is emitted twice under two labels, that is called out below and
  should not be double-counted

Supported DNS record types anywhere this repo emits `DNS Record Types`:

- `A`
- `AAAA`
- `CAA`
- `CNAME`
- `HTTPS`
- `MX`
- `NAPTR`
- `NS`
- `PTR`
- `SOA`
- `SRV`
- `SVCB`
- `TXT`

## AWS

### DDI Objects

- `VPCs`
- `VPC CIDR Blocks`
- `Subnets`
- `Internet Gateways`
- `Transit Gateways`
- `Elastic IP Addresses`
- `Route Tables`
- `VPN Connection`
- `VPN Gateway`
- `Customer Gateway`
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

### Active IP

- `EC2 Instance IPs`

### Assets

- `NAT Gateways`
- `Network Interfaces`
- `Elastic LoadBalancers`
- `Listeners`
- `Target Groups`

## Azure

### DDI Objects

- `vNets`
- `Virtual Network` (same underlying object as `vNets`)
- `Subnets`
- `Virtual Network Subnets` (same underlying objects as `Subnets`)
- `Network Route Tables`
- `Azure DNS Zones`
- `Azure Private DNS Zones`
- `DNS Records (Supported Types)`
- `DNS Records (Unsupported Types)`
- `DNS Record Types`: `A`, `AAAA`, `CAA`, `CNAME`, `HTTPS`, `MX`, `NAPTR`, `NS`, `PTR`, `SOA`, `SRV`, `SVCB`, `TXT`

### Active IP

- `VM IPs`
- `Load Balancer IPs`
- `vNet Gateway IPs`
- `Private Link Services IPs`
- `Private Endpoints IPs`

### Assets

- `Network Interfaces`
- `Networking Load Balancers`
- `Network VNET Gateways`
- `Private Link Services`
- `Private Endpoints`
- `Network NAT Gateways`
- `Network NAT Application Gateways`
- `Network Azure Firewalls`
- `Virtual Machines`
- `Virtual Machine Scale Sets`

## GCP

### DDI Objects

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
- `DNS Record Types`: `A`, `AAAA`, `CAA`, `CNAME`, `HTTPS`, `MX`, `NAPTR`, `NS`, `PTR`, `SOA`, `SRV`, `SVCB`, `TXT`

### Active IP

- `Compute Instance IPs`
- `Load Balancer IPs`
- `GKE Node IPs`
- `GKE Pod IPs`
- `GKE Service IPs`

### Assets

- No explicit high-confidence asset object rows are emitted by the current GCP collector.
- At this level, the collector mostly emits DDI-shaped network inventory plus `Address Records`.
