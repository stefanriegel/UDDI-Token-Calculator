export type ProviderType = 'aws' | 'azure' | 'gcp' | 'ad';

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
  helpText?: string;
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string;
  fields: CredentialField[];
}

export interface ProviderOption {
  id: ProviderType;
  name: string;
  fullName: string;
  color: string;
  description: string;
  authMethods: AuthMethod[];
  subscriptionLabel: string;
}

export const PROVIDERS: ProviderOption[] = [
  {
    id: 'aws',
    name: 'AWS',
    fullName: 'Amazon Web Services',
    color: '#ff9900',
    description: 'Route 53 DNS zones, VPC DHCP options, and Elastic IPs',
    subscriptionLabel: 'Accounts',
    authMethods: [
      {
        id: 'sso',
        name: 'IAM Identity Center (SSO)',
        description: 'Sign in via your corporate identity provider in the browser',
        fields: [
          { key: 'ssoStartUrl', label: 'SSO Start URL', placeholder: 'https://my-org.awsapps.com/start' },
          { key: 'ssoRegion', label: 'SSO Region', placeholder: 'us-east-1' },
        ],
      },
      {
        id: 'profile',
        name: 'AWS CLI Profile',
        description: 'Use a named profile from ~/.aws/credentials or ~/.aws/config',
        fields: [
          { key: 'profile', label: 'Profile Name', placeholder: 'default' },
        ],
      },
      {
        id: 'access-key',
        name: 'Access Key & Secret',
        description: 'Programmatic IAM user credentials (least recommended)',
        fields: [
          { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA... or ASIA...' },
          { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '********', secret: true },
          { key: 'sessionToken', label: 'Session Token (optional)', placeholder: 'Required for temporary STS credentials', secret: true },
          { key: 'region', label: 'Default Region', placeholder: 'us-east-1' },
        ],
      },
      {
        id: 'assume-role',
        name: 'Assume Role (Cross-Account)',
        description: 'Assume an IAM role in a target account using STS',
        fields: [
          { key: 'roleArn', label: 'Role ARN', placeholder: 'arn:aws:iam::123456789012:role/ReadOnlyScanner' },
          { key: 'externalId', label: 'External ID (optional)', placeholder: 'External ID if required' },
          { key: 'sourceProfile', label: 'Source Profile', placeholder: 'default', helpText: 'AWS CLI profile to use for assuming the role' },
        ],
      },
    ],
  },
  {
    id: 'azure',
    name: 'Azure',
    fullName: 'Microsoft Azure',
    color: '#0078d4',
    description: 'Azure DNS zones, Virtual Network DHCP, and IP allocations',
    subscriptionLabel: 'Subscriptions',
    authMethods: [
      {
        id: 'browser-sso',
        name: 'Browser Login (SSO)',
        description: 'Sign in interactively via your Entra ID / Microsoft account',
        fields: [
          { key: 'tenantId', label: 'Tenant ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', helpText: 'Your Azure AD / Entra ID tenant identifier' },
        ],
      },
      {
        id: 'device-code',
        name: 'Device Code Flow',
        description: 'Authenticate on another device using a one-time code',
        fields: [
          { key: 'tenantId', label: 'Tenant ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
        ],
      },
      {
        id: 'service-principal',
        name: 'Service Principal (Client Secret)',
        description: 'App registration with client ID and secret',
        fields: [
          { key: 'tenantId', label: 'Tenant ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
          { key: 'clientId', label: 'Client (App) ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
          { key: 'clientSecret', label: 'Client Secret', placeholder: '********', secret: true },
        ],
      },
      {
        id: 'certificate',
        name: 'Service Principal (Certificate)',
        description: 'App registration with X.509 certificate authentication',
        fields: [
          { key: 'tenantId', label: 'Tenant ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
          { key: 'clientId', label: 'Client (App) ID', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
          { key: 'certPath', label: 'Certificate Path (.pem)', placeholder: 'C:\\certs\\scanner-cert.pem', helpText: 'Path to PEM file containing certificate and private key' },
        ],
      },
      {
        id: 'az-cli',
        name: 'Azure CLI (az login)',
        description: 'Use existing Azure CLI session (requires az login)',
        fields: [],
      },
    ],
  },
  {
    id: 'gcp',
    name: 'GCP',
    fullName: 'Google Cloud Platform',
    color: '#4285f4',
    description: 'Cloud DNS managed zones and VPC subnet IP ranges',
    subscriptionLabel: 'Projects',
    authMethods: [
      {
        id: 'service-account',
        name: 'Service Account Key (JSON)',
        description: 'Upload or paste a service account key file. The service account must have the Compute Viewer and DNS Reader predefined roles (or equivalent: compute.readonly + dns.readonly OAuth2 scopes).',
        fields: [
          { key: 'serviceAccountJson', label: 'Service Account Key', placeholder: 'Paste JSON key contents or path to .json file', multiline: true },
        ],
      },
      {
        id: 'adc',
        name: 'Application Default Credentials',
        description: 'Uses gcloud auth application-default login credentials — no fields required. The authenticated identity must have Compute Viewer and DNS Reader roles.',
        fields: [],
      },
    ],
  },
  {
    id: 'ad',
    name: 'MS DHCP/DNS',
    fullName: 'Microsoft DHCP & DNS Server',
    color: '#7fba00',
    description: 'On-prem Windows Server DHCP scopes and DNS zones',
    subscriptionLabel: 'Servers',
    authMethods: [
      {
        id: 'ntlm',
        name: 'Username & Password (NTLM)',
        description: 'Authenticate with domain credentials. Enter one or more Domain Controller addresses below.',
        fields: [
          { key: 'username', label: 'Username', placeholder: 'DOMAIN\\admin' },
          { key: 'password', label: 'Password', placeholder: '********', secret: true },
        ],
      },
    ],
  },
];

// Mock subscription/account lists per provider
// Enterprise customers can have 600+ Azure subscriptions, 200+ AWS accounts, etc.
function generateMockSubs(
  prefix: string,
  templates: { name: string; selected: boolean }[],
  bulkCount: number,
  bulkNameFn: (i: number) => string,
  bulkSelected: boolean,
): { id: string; name: string; selected: boolean }[] {
  const subs = templates.map((t, i) => ({ id: `${prefix}-${String(i + 1).padStart(3, '0')}`, ...t }));
  for (let i = 0; i < bulkCount; i++) {
    subs.push({
      id: `${prefix}-${String(subs.length + 1).padStart(3, '0')}`,
      name: bulkNameFn(i),
      selected: bulkSelected,
    });
  }
  return subs;
}

const AWS_TEAMS = ['Platform', 'Data', 'Security', 'Networking', 'ML', 'Analytics', 'DevOps', 'Mobile', 'IoT', 'Payments', 'Identity', 'Compliance', 'Logging', 'Monitoring'];
const AWS_ENVS = ['Prod', 'Staging', 'Dev', 'QA', 'DR', 'Sandbox', 'Perf-Test'];
const AZURE_BUS = ['Finance', 'HR', 'Engineering', 'Marketing', 'Sales', 'Legal', 'Operations', 'Support', 'Research', 'IT', 'Security', 'Compliance', 'Data', 'Analytics', 'Infrastructure'];
const AZURE_ENVS = ['Prod', 'Non-Prod', 'Dev', 'Test', 'UAT', 'Staging', 'DR', 'Sandbox', 'Training', 'Demo'];
const AZURE_REGIONS = ['East US', 'West Europe', 'Southeast Asia', 'Australia East', 'UK South', 'Central India', 'Japan East', 'Brazil South', 'Canada Central', 'Korea Central'];
const GCP_TEAMS = ['infra', 'data', 'ml', 'analytics', 'platform', 'security', 'networking', 'app', 'backend', 'frontend'];
const GCP_ENVS = ['prod', 'staging', 'dev', 'sandbox', 'test', 'perf'];

export const MOCK_SUBSCRIPTIONS: Record<ProviderType, { id: string; name: string; selected: boolean }[]> = {
  aws: generateMockSubs(
    'aws',
    [
      { name: 'Production – Core Platform (112233445566)', selected: true },
      { name: 'Staging – Core Platform (223344556677)', selected: true },
      { name: 'Development – Core Platform (334455667788)', selected: false },
      { name: 'Security – Audit & Logging (445566778899)', selected: true },
      { name: 'Networking – Transit Hub (556677889900)', selected: true },
    ],
    180,
    (i) => {
      const team = AWS_TEAMS[i % AWS_TEAMS.length];
      const env = AWS_ENVS[Math.floor(i / AWS_TEAMS.length) % AWS_ENVS.length];
      const acctNum = String(100000000000 + i * 111).slice(0, 12);
      return `${env} – ${team} (${acctNum})`;
    },
    false,
  ),
  azure: generateMockSubs(
    'az',
    [
      { name: 'Enterprise Production – East US', selected: true },
      { name: 'Enterprise Dev/Test – East US', selected: true },
      { name: 'IT Shared Services – West Europe', selected: true },
      { name: 'Security – SOC Platform – East US', selected: true },
      { name: 'Data Platform – Prod – West Europe', selected: false },
    ],
    590,
    (i) => {
      const bu = AZURE_BUS[i % AZURE_BUS.length];
      const env = AZURE_ENVS[Math.floor(i / AZURE_BUS.length) % AZURE_ENVS.length];
      const region = AZURE_REGIONS[Math.floor(i / (AZURE_BUS.length * 2)) % AZURE_REGIONS.length];
      const seq = String(i + 6).padStart(3, '0');
      return `${bu} – ${env} – ${region} (sub-${seq})`;
    },
    false,
  ),
  gcp: generateMockSubs(
    'gcp',
    [
      { name: 'infra-prod-2026', selected: true },
      { name: 'data-analytics-prod', selected: true },
      { name: 'ml-training-prod', selected: false },
      { name: 'dev-sandbox', selected: false },
    ],
    120,
    (i) => {
      const team = GCP_TEAMS[i % GCP_TEAMS.length];
      const env = GCP_ENVS[Math.floor(i / GCP_TEAMS.length) % GCP_ENVS.length];
      const seq = String(i + 5).padStart(3, '0');
      return `${team}-${env}-${seq}`;
    },
    false,
  ),
  ad: [
    { id: 'ms-001', name: 'DC01.corp.example.com', selected: true },
    { id: 'ms-002', name: 'DC02.corp.example.com', selected: true },
    { id: 'ms-003', name: 'BRANCH-NYC.corp.example.com', selected: false },
    { id: 'ms-004', name: 'BRANCH-LON.corp.example.com', selected: false },
    { id: 'ms-005', name: 'BRANCH-SYD.corp.example.com', selected: false },
    { id: 'ms-006', name: 'DR-DC01.corp.example.com', selected: false },
  ],
};

// Management Token rates per Infoblox Universal DDI Licensing
// See: https://docs.infoblox.com/space/BloxOneDDI/846954761/Universal+DDI+Licensing
export type TokenCategory = 'DDI Objects' | 'Active IPs' | 'Managed Assets';

export const TOKEN_RATES: Record<TokenCategory, number> = {
  'DDI Objects': 25,   // 1 Management Token per 25 DDI Objects
  'Active IPs': 13,    // 1 Management Token per 13 Active IPs
  'Managed Assets': 3, // 1 Management Token per 3 Managed Assets
};

export function calcTokens(category: TokenCategory, count: number): number {
  return Math.ceil(count / TOKEN_RATES[category]);
}

export interface FindingRow {
  provider: ProviderType;
  source: string;
  region: string; // cloud region (e.g. "us-east-1"); empty string for global/non-regional resources
  category: TokenCategory;
  item: string;
  count: number;
  tokensPerUnit: number;
  managementTokens: number;
}

// Helper to build a FindingRow with auto-calculated tokens
function row(provider: ProviderType, source: string, category: TokenCategory, item: string, count: number): FindingRow {
  return { provider, source, region: '', category, item, count, tokensPerUnit: TOKEN_RATES[category], managementTokens: calcTokens(category, count) };
}

// Mock scan results aligned to cloud-bucket-crosswalk.md labels
export function generateMockFindings(selectedProviders: ProviderType[]): FindingRow[] {
  const rows: FindingRow[] = [];
  const data: Record<ProviderType, FindingRow[]> = {
    aws: [
      // DDI Objects (per crosswalk: AWS → DDI Objects)
      row('aws', 'Production', 'DDI Objects', 'VPCs', 6),
      row('aws', 'Production', 'DDI Objects', 'VPC CIDR Blocks', 9),
      row('aws', 'Production', 'DDI Objects', 'Subnets', 48),
      row('aws', 'Production', 'DDI Objects', 'Internet Gateways', 4),
      row('aws', 'Production', 'DDI Objects', 'Transit Gateways', 2),
      row('aws', 'Production', 'DDI Objects', 'Elastic IP Addresses', 18),
      row('aws', 'Production', 'DDI Objects', 'Route Tables', 22),
      row('aws', 'Production', 'DDI Objects', 'VPN Connections', 3),
      row('aws', 'Production', 'DDI Objects', 'VPN Gateways', 2),
      row('aws', 'Production', 'DDI Objects', 'Customer Gateways', 2),
      row('aws', 'Production', 'DDI Objects', 'Resolver Endpoints', 4),
      row('aws', 'Production', 'DDI Objects', 'Resolver Rules', 12),
      row('aws', 'Production', 'DDI Objects', 'Resolver Rule Associations', 18),
      row('aws', 'Production', 'DDI Objects', 'IPAMs', 1),
      row('aws', 'Production', 'DDI Objects', 'IPAM Scopes', 3),
      row('aws', 'Production', 'DDI Objects', 'IPAM Pools', 8),
      row('aws', 'Production', 'DDI Objects', 'IPAM Resource Discoveries', 2),
      row('aws', 'Production', 'DDI Objects', 'IPAM Resource Discovery Associations', 2),
      row('aws', 'Production', 'DDI Objects', 'Route53 Hosted Zones', 14),
      row('aws', 'Production', 'DDI Objects', 'Route53 Record Sets', 1842),
      row('aws', 'Production', 'DDI Objects', 'Route53 Health Checks', 26),
      row('aws', 'Production', 'DDI Objects', 'Route53 Traffic Policies', 3),
      row('aws', 'Production', 'DDI Objects', 'Route53 Traffic Policy Instances', 5),
      row('aws', 'Production', 'DDI Objects', 'Route53 Query Logging Configs', 4),
      row('aws', 'Production', 'DDI Objects', 'Direct Connect Gateways', 1),
      // Active IP (per crosswalk: AWS → Active IP)
      row('aws', 'Production', 'Active IPs', 'EC2 Instance IPs', 2340),
      // Assets (per crosswalk: AWS → Assets)
      row('aws', 'Production', 'Managed Assets', 'NAT Gateways', 6),
      row('aws', 'Production', 'Managed Assets', 'Network Interfaces', 312),
      row('aws', 'Production', 'Managed Assets', 'Elastic LoadBalancers', 14),
      row('aws', 'Production', 'Managed Assets', 'Listeners', 28),
      row('aws', 'Production', 'Managed Assets', 'Target Groups', 22),
    ],
    azure: [
      // DDI Objects (per crosswalk: Azure → DDI Objects)
      row('azure', 'Enterprise Production', 'DDI Objects', 'vNets', 12),
      row('azure', 'Enterprise Production', 'DDI Objects', 'Subnets', 64),
      row('azure', 'Enterprise Production', 'DDI Objects', 'Network Route Tables', 18),
      row('azure', 'Enterprise Production', 'DDI Objects', 'Azure DNS Zones', 8),
      row('azure', 'Enterprise Production', 'DDI Objects', 'Azure Private DNS Zones', 6),
      row('azure', 'Enterprise Production', 'DDI Objects', 'DNS Records (Supported Types)', 1256),
      row('azure', 'Enterprise Production', 'DDI Objects', 'DNS Records (Unsupported Types)', 42),
      // Active IP (per crosswalk: Azure → Active IP)
      row('azure', 'Enterprise Production', 'Active IPs', 'VM IPs', 1890),
      row('azure', 'Enterprise Production', 'Active IPs', 'Load Balancer IPs', 24),
      row('azure', 'Enterprise Production', 'Active IPs', 'vNet Gateway IPs', 8),
      row('azure', 'Enterprise Production', 'Active IPs', 'Private Link Services IPs', 16),
      row('azure', 'Enterprise Production', 'Active IPs', 'Private Endpoints IPs', 92),
      // Assets (per crosswalk: Azure → Assets)
      row('azure', 'Enterprise Production', 'Managed Assets', 'Network Interfaces', 486),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Networking Load Balancers', 12),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Network VNET Gateways', 4),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Private Link Services', 8),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Private Endpoints', 46),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Network NAT Gateways', 6),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Network Application Gateways', 3),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Network Azure Firewalls', 2),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Virtual Machines', 245),
      row('azure', 'Enterprise Production', 'Managed Assets', 'Virtual Machine Scale Sets', 8),
    ],
    gcp: [
      // DDI Objects (per crosswalk: GCP → DDI Objects)
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'VPC Networks', 4),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Primary Subnetworks', 24),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Secondary Subnetworks', 12),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Compute Addresses', 36),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Compute Routers', 8),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Compute Router NAT Mapping Infos', 6),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Compute VPN Gateways', 3),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Compute Target VPN Gateways', 2),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'VPN Tunnels', 6),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'GKE Control Plane IP Ranges', 4),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'GKE Pod IP Ranges', 4),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'GKE Service IP Ranges', 4),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Cloud DNS Zones', 9),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Cloud DNS Records (Supported Types)', 876),
      row('gcp', 'infra-prod-2026', 'DDI Objects', 'Cloud DNS Records (Unsupported Types)', 14),
      // Active IP (per crosswalk: GCP → Active IP)
      row('gcp', 'infra-prod-2026', 'Active IPs', 'Compute Instance IPs', 680),
      row('gcp', 'infra-prod-2026', 'Active IPs', 'Load Balancer IPs', 18),
      row('gcp', 'infra-prod-2026', 'Active IPs', 'GKE Node IPs', 120),
      row('gcp', 'infra-prod-2026', 'Active IPs', 'GKE Pod IPs', 2400),
      row('gcp', 'infra-prod-2026', 'Active IPs', 'GKE Service IPs', 86),
      // Assets — crosswalk notes: no explicit asset rows for GCP collector
    ],
    ad: [
      // Microsoft DHCP/DNS — not in the cloud crosswalk; keeping on-prem labels
      // DDI Objects
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'DNS Forward Zones', 24),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'DNS Reverse Zones', 8),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'DNS Resource Records', 4567),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'DNS Views', 3),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'DHCP Scopes', 45),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'DHCP Reservations', 312),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'IP Subnets', 64),
      row('ad', 'DC01.corp.example.com', 'DDI Objects', 'Address Blocks', 12),
      // Active IPs
      row('ad', 'DC01.corp.example.com', 'Active IPs', 'DHCP Active Leases', 8920),
      row('ad', 'DC01.corp.example.com', 'Active IPs', 'Static IP Assignments', 1245),
      // Assets
      row('ad', 'DC01.corp.example.com', 'Managed Assets', 'Physical Appliances', 2),
      row('ad', 'DC01.corp.example.com', 'Managed Assets', 'Virtual Appliances', 4),
      row('ad', 'DC01.corp.example.com', 'Managed Assets', 'HA Nodes', 2),
    ],
  };

  selectedProviders.forEach(p => {
    if (data[p]) rows.push(...data[p]);
  });

  return rows;
}