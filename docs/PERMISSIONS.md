# Cloud Permissions Reference

The UDDI Token Calculator scans cloud infrastructure to estimate Infoblox Universal DDI management tokens. All permissions listed below are **read-only** -- the scanner never creates, modifies, or deletes any cloud resources.

This document serves as both a setup guide for provisioning IAM permissions before a scan and a security audit reference for reviewing the tool's access footprint.

---

## AWS Permissions

### Single-Account Mode

The following IAM actions are required for a complete scan of a single AWS account:

| IAM Action | Resource Scanned | Token Category |
|---|---|---|
| `sts:GetCallerIdentity` | Account ID resolution | (metadata) |
| `iam:ListAccountAliases` | Account name resolution | (metadata) |
| `ec2:DescribeRegions` | Region enumeration | (metadata) |
| `ec2:DescribeVpcs` | VPCs, VPC CIDR Blocks | DDI Objects |
| `ec2:DescribeSubnets` | Subnets | DDI Objects |
| `ec2:DescribeInstances` | EC2 Instances + IP Enumeration | Managed Assets + Active IPs |
| `ec2:DescribeAddresses` | Elastic IPs | Active IPs |
| `ec2:DescribeNatGateways` | NAT Gateways | Managed Assets |
| `ec2:DescribeTransitGateways` | Transit Gateways | Managed Assets |
| `ec2:DescribeInternetGateways` | Internet Gateways | Managed Assets |
| `ec2:DescribeRouteTables` | Route Tables | DDI Objects |
| `ec2:DescribeSecurityGroups` | Security Groups | DDI Objects |
| `ec2:DescribeVpnGateways` | VPN Gateways | Managed Assets |
| `ec2:DescribeIpamPools` | IPAM Pools | DDI Objects |
| `ec2:DescribeCustomerGateways` | Customer Gateways | Managed Assets |
| `elasticloadbalancing:DescribeLoadBalancers` | ALB / NLB / GWLB | Managed Assets |
| `route53:ListHostedZones` | DNS Hosted Zones | DDI Objects |
| `route53:ListResourceRecordSets` | DNS Records (per zone) | DDI Objects |
| `route53:ListHealthChecks` | Route53 Health Checks | DDI Objects |
| `route53:ListTrafficPolicies` | Route53 Traffic Policies | DDI Objects |
| `route53resolver:ListResolverEndpoints` | Route53 Resolver Endpoints | DDI Objects |

### Organization Mode (additional permissions)

When scanning an entire AWS Organization, the management account also needs:

| IAM Action | Purpose |
|---|---|
| `organizations:ListAccounts` | Discover all accounts in the organization |
| `sts:AssumeRole` | Cross-account access into child accounts |

The AssumeRole target is `arn:aws:iam::*:role/{OrgRoleName}` where `OrgRoleName` defaults to `OrganizationAccountAccessRole`. Each child account must have this role with trust policy allowing the management account to assume it.

### SSO Mode (additional permissions)

When using AWS IAM Identity Center (SSO) authentication:

| IAM Action | Purpose |
|---|---|
| `sso:ListAccountRoles` | Discover available roles for the SSO account |
| `sso:GetRoleCredentials` | Exchange SSO token for temporary STS credentials |

### Recommended IAM Policy (Single Account)

A minimal IAM policy covering all single-account scan actions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UDDITokenCalculatorReadOnly",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "iam:ListAccountAliases",
        "ec2:DescribeRegions",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeInstances",
        "ec2:DescribeAddresses",
        "ec2:DescribeNatGateways",
        "ec2:DescribeTransitGateways",
        "ec2:DescribeInternetGateways",
        "ec2:DescribeRouteTables",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeVpnGateways",
        "ec2:DescribeIpamPools",
        "ec2:DescribeCustomerGateways",
        "elasticloadbalancing:DescribeLoadBalancers",
        "route53:ListHostedZones",
        "route53:ListResourceRecordSets",
        "route53:ListHealthChecks",
        "route53:ListTrafficPolicies",
        "route53resolver:ListResolverEndpoints"
      ],
      "Resource": "*"
    }
  ]
}
```

> **Note:** The AWS managed policy `ReadOnlyAccess` covers all the above actions but grants significantly broader access than necessary. The custom policy above is recommended for least-privilege compliance.

### Auth Methods

- **Access Key** -- static IAM user credentials (access key ID + secret access key)
- **Named Profile** -- uses a profile from `~/.aws/config`
- **SSO** -- AWS IAM Identity Center browser-based login
- **Assume Role** -- STS AssumeRole with a source profile

---

## Azure Permissions

### Required RBAC Permissions

The following Azure resource provider operations are required for a complete scan:

| RBAC Permission | Resource Scanned | Token Category |
|---|---|---|
| `Microsoft.Resources/subscriptions/read` | Subscription name resolution | (metadata) |
| `Microsoft.Network/virtualNetworks/read` | VNets + Subnets | DDI Objects |
| `Microsoft.Network/dnszones/read` | Public DNS Zones | DDI Objects |
| `Microsoft.Network/dnszones/recordsets/read` | Public DNS Records | DDI Objects |
| `Microsoft.Network/privateDnsZones/read` | Private DNS Zones | DDI Objects |
| `Microsoft.Network/privateDnsZones/recordSets/read` | Private DNS Records | DDI Objects |
| `Microsoft.Network/networkInterfaces/read` | VM NIC IPs | Active IPs |
| `Microsoft.Network/loadBalancers/read` | Load Balancers + Frontend IPs | Managed Assets + Active IPs |
| `Microsoft.Network/applicationGateways/read` | Application Gateways | Managed Assets |
| `Microsoft.Network/publicIPAddresses/read` | Public IP Addresses | DDI Objects |
| `Microsoft.Network/natGateways/read` | NAT Gateways | Managed Assets |
| `Microsoft.Network/azureFirewalls/read` | Azure Firewalls | Managed Assets |
| `Microsoft.Network/privateEndpoints/read` | Private Endpoints | Managed Assets |
| `Microsoft.Network/virtualNetworkGateways/read` | VNet Gateways + Gateway IPs | Managed Assets + Active IPs |
| `Microsoft.Network/virtualHubs/read` | Virtual Hubs (Virtual WAN) | Managed Assets |
| `Microsoft.Resources/subscriptions/resourceGroups/read` | Resource Group enumeration | (metadata) |
| `Microsoft.Network/routeTables/read` | Route Tables | (internal) |

### Recommended Built-in Role

The Azure built-in role **Reader** (`acdd72a7-3385-48ef-bd42-f606fba81ae7`) at the subscription scope covers all required permissions listed above.

### Custom Role Definition (Least Privilege)

For environments requiring minimal permissions, create a custom role with only the required actions:

```json
{
  "Name": "UDDI Token Calculator Reader",
  "Description": "Read-only access for UDDI Token Calculator cloud infrastructure scanning",
  "Actions": [
    "Microsoft.Resources/subscriptions/read",
    "Microsoft.Resources/subscriptions/resourceGroups/read",
    "Microsoft.Network/virtualNetworks/read",
    "Microsoft.Network/dnszones/read",
    "Microsoft.Network/dnszones/recordsets/read",
    "Microsoft.Network/privateDnsZones/read",
    "Microsoft.Network/privateDnsZones/recordSets/read",
    "Microsoft.Network/networkInterfaces/read",
    "Microsoft.Network/loadBalancers/read",
    "Microsoft.Network/applicationGateways/read",
    "Microsoft.Network/publicIPAddresses/read",
    "Microsoft.Network/natGateways/read",
    "Microsoft.Network/azureFirewalls/read",
    "Microsoft.Network/privateEndpoints/read",
    "Microsoft.Network/virtualNetworkGateways/read",
    "Microsoft.Network/virtualHubs/read",
    "Microsoft.Network/routeTables/read"
  ],
  "NotActions": [],
  "DataActions": [],
  "NotDataActions": [],
  "AssignableScopes": [
    "/subscriptions/{subscription-id}"
  ]
}
```

Replace `{subscription-id}` with the target subscription ID. For multi-subscription scans, add each subscription to `AssignableScopes` or assign at the management group level.

### Auth Methods

- **Service Principal** -- client ID + client secret + tenant ID (default and most common)
- **Browser SSO** -- interactive browser login via Azure AD
- **Azure CLI** -- uses credentials from `az login`
- **Certificate** -- client certificate authentication
- **Device Code** -- device code flow for headless environments

---

## GCP Permissions

### Required OAuth Scopes

The scanner requests the following OAuth2 scopes:

| Scope | Purpose |
|---|---|
| `https://www.googleapis.com/auth/compute.readonly` | Compute Engine read access (VPCs, subnets, instances, IPs, firewalls, routers, VPN gateways, forwarding rules) |
| `https://www.googleapis.com/auth/dns.readonly` | Cloud DNS read access (zones and record sets) |

### Required IAM Permissions

The following GCP IAM permissions are required for a complete scan:

| IAM Permission | Resource Scanned | Token Category |
|---|---|---|
| `compute.networks.list` | VPC Networks | DDI Objects |
| `compute.subnetworks.aggregatedList` | Subnets | DDI Objects |
| `compute.subnetworks.list` | Secondary Subnet Ranges | DDI Objects |
| `dns.managedZones.list` | Cloud DNS Zones | DDI Objects |
| `dns.resourceRecordSets.list` | Cloud DNS Records | DDI Objects |
| `compute.instances.aggregatedList` | Compute Instances + IP Enumeration | Managed Assets + Active IPs |
| `compute.addresses.aggregatedList` | Static/Reserved IPs | Active IPs |
| `compute.forwardingRules.aggregatedList` | Forwarding Rules (LB Frontends) | Managed Assets |
| `compute.firewalls.list` | Firewall Rules | DDI Objects |
| `compute.routers.aggregatedList` | Cloud Routers | Managed Assets |
| `compute.vpnGateways.aggregatedList` | VPN Gateways | Managed Assets |
| `compute.vpnTunnels.aggregatedList` | VPN Tunnels | Managed Assets |
| `networkconnectivity.internalRanges.list` | Internal Ranges (Address Blocks) | DDI Objects |
| `container.clusters.list` | GKE Cluster CIDRs | DDI Objects |

### Organization Mode (additional permissions)

When scanning all projects in a GCP organization:

| IAM Permission | Purpose |
|---|---|
| `resourcemanager.projects.search` | Discover projects across the organization |
| `resourcemanager.folders.list` | Traverse folder hierarchy for project discovery |

### Recommended Predefined Roles

**Single Project:**

| Role | Scope | Covers |
|---|---|---|
| `roles/compute.viewer` | Project | All Compute Engine read permissions |
| `roles/dns.reader` | Project | All Cloud DNS read permissions |

**Organization Mode (additional roles):**

| Role | Scope | Covers |
|---|---|---|
| `roles/resourcemanager.folderViewer` | Organization | Folder hierarchy traversal |
| `roles/browser` | Organization | Project listing and search |

> **Note:** The `container.clusters.list` permission (for GKE cluster CIDRs) is not included in `roles/compute.viewer`. If GKE scanning is needed, also grant `roles/container.viewer` at the project level. If missing, GKE scanning fails gracefully and returns zero counts without blocking the rest of the scan.

### Auth Methods

- **Service Account JSON Key** -- downloaded JSON key file (default)
- **Application Default Credentials (ADC)** -- uses `gcloud auth application-default login`
- **Browser OAuth** -- interactive browser consent flow
- **Workload Identity Federation** -- external identity provider (OIDC/SAML) for keyless authentication

---

## Quick Reference

| Provider | Recommended Role / Policy | Scope | Org Mode Extra |
|---|---|---|---|
| **AWS** | Custom policy (see above) or `ReadOnlyAccess` | Account | `organizations:ListAccounts` + `sts:AssumeRole` |
| **Azure** | `Reader` built-in role | Subscription | (none -- multi-subscription via role assignment) |
| **GCP** | `roles/compute.viewer` + `roles/dns.reader` | Project | `roles/resourcemanager.folderViewer` + `roles/browser` |
