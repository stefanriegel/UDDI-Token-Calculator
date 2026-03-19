import niosGridLogo from '../../assets/logos/nios-grid.svg';
import infobloxLogo from '../../assets/logos/infoblox.svg';
import awsLogo from '../../assets/logos/aws.svg';
import azureLogo from '../../assets/logos/azure.svg';
import gcpLogo from '../../assets/logos/gcp.svg';
import microsoftLogo from '../../assets/logos/microsoft.svg';
import bluecatLogo from '../../assets/logos/bluecat.svg';
import efficientipLogo from '../../assets/logos/efficientip.svg';

export type ProviderType = 'aws' | 'azure' | 'gcp' | 'microsoft' | 'nios' | 'bluecat' | 'efficientip';

/**
 * Map frontend provider IDs to backend API provider IDs.
 * The Go backend uses 'ad' for Microsoft DHCP/DNS, the UI uses 'microsoft'.
 */
export const BACKEND_PROVIDER_ID: Record<ProviderType, string> = {
  aws: 'aws',
  azure: 'azure',
  gcp: 'gcp',
  microsoft: 'ad',
  nios: 'nios',
  bluecat: 'bluecat',
  efficientip: 'efficientip',
};

/**
 * Reverse map: backend provider ID -> frontend ProviderType.
 */
export function toFrontendProvider(backendId: string): ProviderType {
  if (backendId === 'ad') return 'microsoft';
  // bluecat and efficientip use identical IDs on both sides
  return backendId as ProviderType;
}

export const NIOS_GRID_LOGO = niosGridLogo;
export const INFOBLOX_LOGO = infobloxLogo;

export const PROVIDER_LOGOS: Record<ProviderType, string> = {
  aws: awsLogo,
  azure: azureLogo,
  gcp: gcpLogo,
  microsoft: microsoftLogo,
  nios: niosGridLogo,
  bluecat: bluecatLogo,
  efficientip: efficientipLogo,
};

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  multiline?: boolean;
  serverList?: boolean;
  helpText?: string;
}

export interface AuthMethod {
  id: string;
  name: string;
  description: string;
  fields: CredentialField[];
  /** If true, this auth method is only shown when the backend reports platform === "windows" */
  windowsOnly?: boolean;
}

export interface ProviderOption {
  id: ProviderType;
  name: string;
  fullName: string;
  color: string;
  description: string;
  authMethods: AuthMethod[];
  subscriptionLabel: string;
  /** If true, Step 2 shows a file upload dropzone instead of credential fields */
  isFileUpload?: boolean;
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
          { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA...' },
          { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '********', secret: true },
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
      {
        id: 'org',
        name: 'Org Scanning (AWS Organizations)',
        description: 'Scan all accounts in your AWS Organization by assuming a role in each child account',
        fields: [
          { key: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA...' },
          { key: 'secretAccessKey', label: 'Secret Access Key', placeholder: '********', secret: true },
          { key: 'region', label: 'Default Region', placeholder: 'us-east-1', helpText: 'Optional — defaults to us-east-1' },
          { key: 'orgRoleName', label: 'Org Role Name', placeholder: 'OrganizationAccountAccessRole', helpText: 'IAM role name assumed in each child account' },
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
        id: 'browser-oauth',
        name: 'Browser Login (OAuth)',
        description: 'Sign in interactively via your Google Workspace account',
        fields: [],
      },
      {
        id: 'adc',
        name: 'Application Default Credentials',
        description: 'Use gcloud auth application-default login session',
        fields: [],
      },
      {
        id: 'service-account',
        name: 'Service Account Key (JSON)',
        description: 'Upload or paste a service account key file',
        fields: [
          { key: 'serviceAccountJson', label: 'Service Account Key', placeholder: 'Paste JSON key contents or path to .json file', multiline: true },
        ],
      },
      {
        id: 'workload-identity',
        name: 'Workload Identity Federation',
        description: 'Federated identity from AWS, Azure AD, or OIDC provider',
        fields: [
          { key: 'projectNumber', label: 'Project Number', placeholder: '123456789012' },
          { key: 'poolId', label: 'Workload Identity Pool ID', placeholder: 'my-pool' },
          { key: 'providerId', label: 'Provider ID', placeholder: 'my-provider' },
          { key: 'serviceAccountEmail', label: 'Service Account Email', placeholder: 'scanner@project.iam.gserviceaccount.com' },
        ],
      },
      {
        id: 'org',
        name: 'Org Scanning (GCP Organization)',
        description: 'Scan all projects in your GCP Organization using org-level service account permissions',
        fields: [
          { key: 'orgId', label: 'Organization ID', placeholder: '123456789', helpText: 'GCP organization ID (numeric)' },
          { key: 'serviceAccountJson', label: 'Service Account Key', placeholder: 'Paste JSON key with org-level permissions', multiline: true },
        ],
      },
    ],
  },
  {
    id: 'microsoft',
    name: 'MS DHCP/DNS',
    fullName: 'Microsoft DHCP & DNS Server',
    color: '#7fba00',
    description: 'On-prem Windows Server DHCP scopes and DNS zones',
    subscriptionLabel: 'Servers',
    authMethods: [
      {
        id: 'sspi',
        name: 'Windows SSO (Current User)',
        description: 'Use your current Windows domain session — no password required. Only available on domain-joined Windows hosts.',
        windowsOnly: true,
        fields: [
          { key: 'servers', label: 'Domain Controller', placeholder: 'dc01.corp.local', serverList: true, helpText: 'Hostname or IP of one or more domain controllers' },
        ],
      },
      {
        id: 'kerberos',
        name: 'Kerberos (username + password)',
        description: 'Authenticate with on-premises AD credentials via Kerberos — works from any host, no domain join required',
        fields: [
          { key: 'servers', label: 'Domain Controller', placeholder: 'dc01.corp.local', serverList: true, helpText: 'Hostname or IP of one or more domain controllers' },
          { key: 'username', label: 'Username', placeholder: 'administrator', helpText: 'On-premises AD user (not an Entra ID-only account)' },
          { key: 'password', label: 'Password', placeholder: '********', secret: true },
          { key: 'realm', label: 'Kerberos Realm', placeholder: 'CORP.EXAMPLE.COM', helpText: 'AD domain in uppercase, e.g. CORP.EXAMPLE.COM' },
          { key: 'kdc', label: 'KDC Address (optional)', placeholder: 'dc01.corp.local:88', helpText: 'Defaults to the first DC on port 88' },
        ],
      },
      {
        id: 'ntlm',
        name: 'Username & Password (NTLM)',
        description: 'Authenticate with on-premises AD credentials via NTLM — use this from an Entra ID-joined or non-domain-joined machine',
        fields: [
          { key: 'servers', label: 'Domain Controller', placeholder: 'dc01.corp.local', serverList: true, helpText: 'Hostname or IP of one or more domain controllers' },
          { key: 'username', label: 'Username', placeholder: 'CORP\\admin', helpText: 'On-premises AD user — use DOMAIN\\user or user@domain.local format. Entra ID-only accounts (user@tenant.onmicrosoft.com) are not supported.' },
          { key: 'password', label: 'Password', placeholder: '********', secret: true },
        ],
      },
      {
        id: 'powershell-remote',
        name: 'PowerShell Remoting (WinRM / HTTPS)',
        description: 'Connect via encrypted WinRM (HTTPS) — recommended for production environments with valid TLS certificates',
        fields: [
          { key: 'servers', label: 'Domain Controller', placeholder: 'dc01.corp.local', serverList: true, helpText: 'Hostname or IP of one or more domain controllers' },
          { key: 'username', label: 'Username', placeholder: 'CORP\\admin' },
          { key: 'password', label: 'Password', placeholder: '********', secret: true },
          { key: 'useSSL', label: 'Use HTTPS (port 5986)', placeholder: 'true', helpText: 'Enable for encrypted WinRM transport' },
          { key: 'insecureSkipVerify', label: 'Allow untrusted certificates', placeholder: 'true', helpText: 'Skip TLS certificate validation (common for self-signed certs)' },
        ],
      },
    ],
  },
  {
    id: 'nios',
    name: 'NIOS',
    fullName: 'Infoblox NIOS Grid',
    color: '#00a5e5',
    description: 'Upload a Grid backup or connect via WAPI to extract DNS, DHCP, and IPAM objects',
    subscriptionLabel: 'Grid Members',
    isFileUpload: true,
    authMethods: [
      {
        id: 'backup-upload',
        name: 'Grid Backup Upload',
        description: 'Upload a NIOS Grid backup file (.tar.gz, .tgz, .bak) or onedb.xml exported from the Grid Master.',
        fields: [],
      },
      {
        id: 'wapi',
        name: 'Live API (WAPI)',
        description: 'Connect directly to the NIOS Grid Manager via the Web API (WAPI) to discover DDI objects in real-time.',
        fields: [
          { key: 'wapi_url', label: 'Grid Manager URL', placeholder: 'https://grid-manager.example.com' },
          { key: 'wapi_username', label: 'Username', placeholder: 'admin' },
          { key: 'wapi_password', label: 'Password', placeholder: '', secret: true },
          { key: 'wapi_version', label: 'WAPI Version (optional)', placeholder: 'auto-detect' },
        ],
      },
    ],
  },
  {
    id: 'bluecat',
    name: 'BlueCat',
    fullName: 'BlueCat Address Manager',
    color: '#0065A3',
    description: 'DNS zones, IP blocks, networks, and DHCP ranges',
    subscriptionLabel: 'Configurations',
    authMethods: [
      {
        id: 'credentials',
        name: 'API Credentials',
        description: 'BlueCat Address Manager URL and credentials',
        fields: [
          { key: 'bluecat_url', label: 'BlueCat URL', placeholder: 'https://bluecat.example.com' },
          { key: 'bluecat_username', label: 'Username', placeholder: 'admin' },
          { key: 'bluecat_password', label: 'Password', placeholder: '', secret: true },
        ],
      },
    ],
  },
  {
    id: 'efficientip',
    name: 'EfficientIP',
    fullName: 'EfficientIP SOLIDserver',
    color: '#00A651',
    description: 'DNS views, IP subnets, pools, and DHCP scopes',
    subscriptionLabel: 'Sites',
    authMethods: [
      {
        id: 'credentials',
        name: 'API Credentials',
        description: 'EfficientIP SOLIDserver URL and credentials',
        fields: [
          { key: 'efficientip_url', label: 'SOLIDserver URL', placeholder: 'https://solidserver.example.com' },
          { key: 'efficientip_username', label: 'Username', placeholder: 'admin' },
          { key: 'efficientip_password', label: 'Password', placeholder: '', secret: true },
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
      { name: 'Production \u2013 Core Platform (112233445566)', selected: true },
      { name: 'Staging \u2013 Core Platform (223344556677)', selected: true },
      { name: 'Development \u2013 Core Platform (334455667788)', selected: false },
      { name: 'Security \u2013 Audit & Logging (445566778899)', selected: true },
      { name: 'Networking \u2013 Transit Hub (556677889900)', selected: true },
    ],
    180,
    (i) => {
      const team = AWS_TEAMS[i % AWS_TEAMS.length];
      const env = AWS_ENVS[Math.floor(i / AWS_TEAMS.length) % AWS_ENVS.length];
      const acctNum = String(100000000000 + i * 111).slice(0, 12);
      return `${env} \u2013 ${team} (${acctNum})`;
    },
    false,
  ),
  azure: generateMockSubs(
    'az',
    [
      { name: 'Enterprise Production \u2013 East US', selected: true },
      { name: 'Enterprise Dev/Test \u2013 East US', selected: true },
      { name: 'IT Shared Services \u2013 West Europe', selected: true },
      { name: 'Security \u2013 SOC Platform \u2013 East US', selected: true },
      { name: 'Data Platform \u2013 Prod \u2013 West Europe', selected: false },
    ],
    590,
    (i) => {
      const bu = AZURE_BUS[i % AZURE_BUS.length];
      const env = AZURE_ENVS[Math.floor(i / AZURE_BUS.length) % AZURE_ENVS.length];
      const region = AZURE_REGIONS[Math.floor(i / (AZURE_BUS.length * 2)) % AZURE_REGIONS.length];
      const seq = String(i + 6).padStart(3, '0');
      return `${bu} \u2013 ${env} \u2013 ${region} (sub-${seq})`;
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
  microsoft: [
    { id: 'ms-001', name: 'DC01.corp.example.com', selected: true },
    { id: 'ms-002', name: 'DC02.corp.example.com', selected: true },
    { id: 'ms-003', name: 'BRANCH-NYC.corp.example.com', selected: false },
    { id: 'ms-004', name: 'BRANCH-LON.corp.example.com', selected: false },
    { id: 'ms-005', name: 'BRANCH-SYD.corp.example.com', selected: false },
    { id: 'ms-006', name: 'DR-DC01.corp.example.com', selected: false },
  ],
  nios: [
    { id: 'nios-gm', name: 'infoblox-gm.corp.example.com (Grid Master)', selected: true },
    { id: 'nios-gmc', name: 'infoblox-gmc.corp.example.com (Grid Master Candidate)', selected: true },
    { id: 'nios-dns-east', name: 'dns-east-01.corp.example.com (DNS)', selected: true },
    { id: 'nios-dns-west', name: 'dns-west-01.corp.example.com (DNS)', selected: true },
    { id: 'nios-dhcp-east', name: 'dhcp-east-01.corp.example.com (DHCP)', selected: true },
    { id: 'nios-dhcp-west', name: 'dhcp-west-01.corp.example.com (DHCP)', selected: false },
    { id: 'nios-ipam', name: 'ipam-01.corp.example.com (IPAM)', selected: true },
    { id: 'nios-reporting', name: 'reporting-01.corp.example.com (Reporting)', selected: false },
  ],
  bluecat: [
    { id: 'bluecat-1', name: 'BlueCat Instance', selected: true },
  ],
  efficientip: [
    { id: 'efficientip-1', name: 'EfficientIP Instance', selected: true },
  ],
};

// Management Token rates per Infoblox Universal DDI Licensing
// See: https://docs.infoblox.com/space/BloxOneDDI/846954761/Universal+DDI+Licensing
export type TokenCategory = 'DDI Object' | 'Active IP' | 'Asset';

export const TOKEN_RATES: Record<TokenCategory, number> = {
  'DDI Object': 25,  // 1 Management Token per 25 DDI Objects
  'Active IP': 13,   // 1 Management Token per 13 Active IPs
  'Asset': 3,        // 1 Management Token per 3 Assets
};

/**
 * Map backend category names to frontend TokenCategory.
 * The Go backend uses 'DDI Objects', 'Active IPs', 'Managed Assets'.
 */
export function toFrontendCategory(backendCategory: string): TokenCategory {
  switch (backendCategory) {
    case 'DDI Objects': return 'DDI Object';
    case 'Active IPs': return 'Active IP';
    case 'Managed Assets': return 'Asset';
    default: return backendCategory as TokenCategory;
  }
}

export function calcTokens(category: TokenCategory, count: number): number {
  return Math.ceil(count / TOKEN_RATES[category]);
}

export interface FindingRow {
  provider: ProviderType;
  source: string;
  category: TokenCategory;
  item: string;
  count: number;
  tokensPerUnit: number;
  managementTokens: number;
}

// NIOS traditional licensing rates (different from UDDI rates above)
// NIOS uses more generous ratios since it's on-prem licensing
export const NIOS_TOKEN_RATES: Record<TokenCategory, number> = {
  'DDI Object': 50,  // 1 token per 50 DDI Objects
  'Active IP': 25,   // 1 token per 25 Active IPs
  'Asset': 13,       // 1 token per 13 Assets
};

/**
 * Calculate NIOS licensing tokens for a set of findings.
 * Uses NIOS-specific ratios (50/25/13) and returns the max across categories
 * (same max-of-three approach as UDDI token calculation).
 */
export function calcNiosTokens(rows: FindingRow[]): number {
  const ddi = rows.filter(f => f.category === 'DDI Object').reduce((s, f) => s + f.count, 0);
  const ips = rows.filter(f => f.category === 'Active IP').reduce((s, f) => s + f.count, 0);
  const assets = rows.filter(f => f.category === 'Asset').reduce((s, f) => s + f.count, 0);
  return Math.max(
    Math.ceil(ddi / NIOS_TOKEN_RATES['DDI Object']),
    Math.ceil(ips / NIOS_TOKEN_RATES['Active IP']),
    Math.ceil(assets / NIOS_TOKEN_RATES['Asset'])
  );
}

// Helper to build a FindingRow with auto-calculated tokens
function row(provider: ProviderType, source: string, category: TokenCategory, item: string, count: number): FindingRow {
  return { provider, source, category, item, count, tokensPerUnit: TOKEN_RATES[category], managementTokens: calcTokens(category, count) };
}

// Mock scan results aligned to cloud-bucket-crosswalk.md labels
export function generateMockFindings(selectedProviders: ProviderType[]): FindingRow[] {
  const rows: FindingRow[] = [];
  const data: Record<ProviderType, FindingRow[]> = {
    aws: [
      // DDI Objects (per crosswalk: AWS -> DDI Objects)
      row('aws', 'Production', 'DDI Object', 'VPCs', 6),
      row('aws', 'Production', 'DDI Object', 'VPC CIDR Blocks', 9),
      row('aws', 'Production', 'DDI Object', 'Subnets', 48),
      row('aws', 'Production', 'DDI Object', 'Internet Gateways', 4),
      row('aws', 'Production', 'DDI Object', 'Transit Gateways', 2),
      row('aws', 'Production', 'DDI Object', 'Elastic IP Addresses', 18),
      row('aws', 'Production', 'DDI Object', 'Route Tables', 22),
      row('aws', 'Production', 'DDI Object', 'VPN Connections', 3),
      row('aws', 'Production', 'DDI Object', 'VPN Gateways', 2),
      row('aws', 'Production', 'DDI Object', 'Customer Gateways', 2),
      row('aws', 'Production', 'DDI Object', 'Resolver Endpoints', 4),
      row('aws', 'Production', 'DDI Object', 'Resolver Rules', 12),
      row('aws', 'Production', 'DDI Object', 'Resolver Rule Associations', 18),
      row('aws', 'Production', 'DDI Object', 'IPAMs', 1),
      row('aws', 'Production', 'DDI Object', 'IPAM Scopes', 3),
      row('aws', 'Production', 'DDI Object', 'IPAM Pools', 8),
      row('aws', 'Production', 'DDI Object', 'IPAM Resource Discoveries', 2),
      row('aws', 'Production', 'DDI Object', 'IPAM Resource Discovery Associations', 2),
      row('aws', 'Production', 'DDI Object', 'Route53 Hosted Zones', 14),
      row('aws', 'Production', 'DDI Object', 'Route53 Record Sets', 1842),
      row('aws', 'Production', 'DDI Object', 'Route53 Health Checks', 26),
      row('aws', 'Production', 'DDI Object', 'Route53 Traffic Policies', 3),
      row('aws', 'Production', 'DDI Object', 'Route53 Traffic Policy Instances', 5),
      row('aws', 'Production', 'DDI Object', 'Route53 Query Logging Configs', 4),
      row('aws', 'Production', 'DDI Object', 'Direct Connect Gateways', 1),
      // Active IP (per crosswalk: AWS -> Active IP)
      row('aws', 'Production', 'Active IP', 'EC2 Instance IPs', 2340),
      // Assets (per crosswalk: AWS -> Assets)
      row('aws', 'Production', 'Asset', 'NAT Gateways', 6),
      row('aws', 'Production', 'Asset', 'Network Interfaces', 312),
      row('aws', 'Production', 'Asset', 'Elastic LoadBalancers', 14),
      row('aws', 'Production', 'Asset', 'Listeners', 28),
      row('aws', 'Production', 'Asset', 'Target Groups', 22),
    ],
    azure: [
      // DDI Objects (per crosswalk: Azure -> DDI Objects)
      row('azure', 'Enterprise Production', 'DDI Object', 'vNets', 12),
      row('azure', 'Enterprise Production', 'DDI Object', 'Subnets', 64),
      row('azure', 'Enterprise Production', 'DDI Object', 'Network Route Tables', 18),
      row('azure', 'Enterprise Production', 'DDI Object', 'Azure DNS Zones', 8),
      row('azure', 'Enterprise Production', 'DDI Object', 'Azure Private DNS Zones', 6),
      row('azure', 'Enterprise Production', 'DDI Object', 'DNS Records (Supported Types)', 1256),
      row('azure', 'Enterprise Production', 'DDI Object', 'DNS Records (Unsupported Types)', 42),
      // Active IP (per crosswalk: Azure -> Active IP)
      row('azure', 'Enterprise Production', 'Active IP', 'VM IPs', 1890),
      row('azure', 'Enterprise Production', 'Active IP', 'Load Balancer IPs', 24),
      row('azure', 'Enterprise Production', 'Active IP', 'vNet Gateway IPs', 8),
      row('azure', 'Enterprise Production', 'Active IP', 'Private Link Services IPs', 16),
      row('azure', 'Enterprise Production', 'Active IP', 'Private Endpoints IPs', 92),
      // Assets (per crosswalk: Azure -> Assets)
      row('azure', 'Enterprise Production', 'Asset', 'Network Interfaces', 486),
      row('azure', 'Enterprise Production', 'Asset', 'Networking Load Balancers', 12),
      row('azure', 'Enterprise Production', 'Asset', 'Network VNET Gateways', 4),
      row('azure', 'Enterprise Production', 'Asset', 'Private Link Services', 8),
      row('azure', 'Enterprise Production', 'Asset', 'Private Endpoints', 46),
      row('azure', 'Enterprise Production', 'Asset', 'Network NAT Gateways', 6),
      row('azure', 'Enterprise Production', 'Asset', 'Network Application Gateways', 3),
      row('azure', 'Enterprise Production', 'Asset', 'Network Azure Firewalls', 2),
      row('azure', 'Enterprise Production', 'Asset', 'Virtual Machines', 245),
      row('azure', 'Enterprise Production', 'Asset', 'Virtual Machine Scale Sets', 8),
    ],
    gcp: [
      // DDI Objects (per crosswalk: GCP -> DDI Objects)
      row('gcp', 'infra-prod-2026', 'DDI Object', 'VPC Networks', 4),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Primary Subnetworks', 24),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Secondary Subnetworks', 12),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Compute Addresses', 36),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Compute Routers', 8),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Compute Router NAT Mapping Infos', 6),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Compute VPN Gateways', 3),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Compute Target VPN Gateways', 2),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'VPN Tunnels', 6),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'GKE Control Plane IP Ranges', 4),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'GKE Pod IP Ranges', 4),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'GKE Service IP Ranges', 4),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Cloud DNS Zones', 9),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Cloud DNS Records (Supported Types)', 876),
      row('gcp', 'infra-prod-2026', 'DDI Object', 'Cloud DNS Records (Unsupported Types)', 14),
      // Active IP (per crosswalk: GCP -> Active IP)
      row('gcp', 'infra-prod-2026', 'Active IP', 'Compute Instance IPs', 680),
      row('gcp', 'infra-prod-2026', 'Active IP', 'Load Balancer IPs', 18),
      row('gcp', 'infra-prod-2026', 'Active IP', 'GKE Node IPs', 120),
      row('gcp', 'infra-prod-2026', 'Active IP', 'GKE Pod IPs', 2400),
      row('gcp', 'infra-prod-2026', 'Active IP', 'GKE Service IPs', 86),
      // Assets -- crosswalk notes: no explicit asset rows for GCP collector
    ],
    microsoft: [
      // Microsoft DHCP/DNS -- not in the cloud crosswalk; keeping on-prem labels
      // DDI Objects
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'DNS Forward Zones', 24),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'DNS Reverse Zones', 8),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'DNS Resource Records', 4567),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'DNS Views', 3),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'DHCP Scopes', 45),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'DHCP Reservations', 312),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'IP Subnets', 64),
      row('microsoft', 'DC01.corp.example.com', 'DDI Object', 'Address Blocks', 12),
      // Active IPs
      row('microsoft', 'DC01.corp.example.com', 'Active IP', 'DHCP Active Leases', 8920),
      row('microsoft', 'DC01.corp.example.com', 'Active IP', 'Static IP Assignments', 1245),
      // Assets
      row('microsoft', 'DC01.corp.example.com', 'Asset', 'Physical Appliances', 2),
      row('microsoft', 'DC01.corp.example.com', 'Asset', 'Virtual Appliances', 4),
      row('microsoft', 'DC01.corp.example.com', 'Asset', 'HA Nodes', 2),
      // Entra ID (Azure AD) enrichment
      row('microsoft', 'Entra ID', 'Asset', 'Entra Users', 4200),
      row('microsoft', 'Entra ID', 'Asset', 'Entra Devices', 1850),
    ],
    nios: [
      // Infoblox NIOS Grid Backup -- per-member findings
      // Grid Master -- DNS + DHCP + IPAM
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DNS Authoritative Zones', 42),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DNS Forward Zones', 18),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DNS Reverse Zones', 24),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DNS Delegated Zones', 8),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DNS Resource Records', 15840),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'Host Records', 3245),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DNS Views', 4),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'Network Views', 3),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DHCP Networks', 86),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DHCP Ranges', 124),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DHCP Fixed Addresses', 1890),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DHCP Failover Associations', 6),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'IP Networks', 156),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'IP Ranges', 42),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'Extensible Attributes', 28),
      row('nios', 'infoblox-gm.corp.example.com', 'DDI Object', 'DHCP Option Spaces', 4),
      row('nios', 'infoblox-gm.corp.example.com', 'Active IP', 'DHCP Active Leases', 12480),
      row('nios', 'infoblox-gm.corp.example.com', 'Active IP', 'Static Host IPs', 3245),
      row('nios', 'infoblox-gm.corp.example.com', 'Active IP', 'Fixed Address IPs', 1890),
      row('nios', 'infoblox-gm.corp.example.com', 'Asset', 'Grid Members', 8),
      row('nios', 'infoblox-gm.corp.example.com', 'Asset', 'HA Pairs', 3),
      row('nios', 'infoblox-gm.corp.example.com', 'Asset', 'Physical Appliances', 4),
      row('nios', 'infoblox-gm.corp.example.com', 'Asset', 'Virtual Appliances', 4),
      // DNS East -- zone delegation
      row('nios', 'dns-east-01.corp.example.com', 'DDI Object', 'DNS Authoritative Zones', 22),
      row('nios', 'dns-east-01.corp.example.com', 'DDI Object', 'DNS Resource Records', 8420),
      row('nios', 'dns-east-01.corp.example.com', 'DDI Object', 'Host Records', 1680),
      row('nios', 'dns-east-01.corp.example.com', 'Active IP', 'Static Host IPs', 1680),
      // DNS West -- zone delegation
      row('nios', 'dns-west-01.corp.example.com', 'DDI Object', 'DNS Authoritative Zones', 18),
      row('nios', 'dns-west-01.corp.example.com', 'DDI Object', 'DNS Resource Records', 6240),
      row('nios', 'dns-west-01.corp.example.com', 'DDI Object', 'Host Records', 1120),
      row('nios', 'dns-west-01.corp.example.com', 'Active IP', 'Static Host IPs', 1120),
      // DHCP East
      row('nios', 'dhcp-east-01.corp.example.com', 'DDI Object', 'DHCP Networks', 42),
      row('nios', 'dhcp-east-01.corp.example.com', 'DDI Object', 'DHCP Ranges', 68),
      row('nios', 'dhcp-east-01.corp.example.com', 'DDI Object', 'DHCP Fixed Addresses', 945),
      row('nios', 'dhcp-east-01.corp.example.com', 'Active IP', 'DHCP Active Leases', 6820),
      row('nios', 'dhcp-east-01.corp.example.com', 'Active IP', 'Fixed Address IPs', 945),
      // DHCP West
      row('nios', 'dhcp-west-01.corp.example.com', 'DDI Object', 'DHCP Networks', 38),
      row('nios', 'dhcp-west-01.corp.example.com', 'DDI Object', 'DHCP Ranges', 52),
      row('nios', 'dhcp-west-01.corp.example.com', 'DDI Object', 'DHCP Fixed Addresses', 720),
      row('nios', 'dhcp-west-01.corp.example.com', 'Active IP', 'DHCP Active Leases', 5140),
      row('nios', 'dhcp-west-01.corp.example.com', 'Active IP', 'Fixed Address IPs', 720),
      // IPAM member
      row('nios', 'ipam-01.corp.example.com', 'DDI Object', 'IP Networks', 86),
      row('nios', 'ipam-01.corp.example.com', 'DDI Object', 'IP Ranges', 24),
      row('nios', 'ipam-01.corp.example.com', 'DDI Object', 'Network Containers', 12),
    ],
    bluecat: [
      row('bluecat', 'BlueCat Instance', 'DDI Object', 'DNS Zones', 34),
      row('bluecat', 'BlueCat Instance', 'DDI Object', 'DNS Resource Records', 2480),
      row('bluecat', 'BlueCat Instance', 'DDI Object', 'IP4 Blocks', 12),
      row('bluecat', 'BlueCat Instance', 'DDI Object', 'IP4 Networks', 86),
      row('bluecat', 'BlueCat Instance', 'DDI Object', 'DHCP Ranges', 42),
      row('bluecat', 'BlueCat Instance', 'DDI Object', 'MAC Addresses', 156),
    ],
    efficientip: [
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'DNS Views', 4),
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'DNS Zones', 28),
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'DNS Resource Records', 1840),
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'IP Subnets', 64),
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'IP Pools', 32),
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'DHCP Scopes', 48),
      row('efficientip', 'EfficientIP Instance', 'DDI Object', 'DHCP Ranges', 38),
    ],
  };

  selectedProviders.forEach(p => {
    if (data[p]) rows.push(...data[p]);
  });

  return rows;
}

// ---- Re-export NIOS calc types and functions from nios-calc.ts ----
// The reference Figma export defines these in mock-data.ts, but we keep the
// authoritative implementation in nios-calc.ts to avoid duplication.
export {
  calcServerTokenTier,
  consolidateXaasInstances,
  XAAS_EXTRA_CONNECTION_COST,
  MOCK_NIOS_SERVER_METRICS,
  type NiosServerMetrics,
  type ServerFormFactor,
  type ConsolidatedXaasInstance,
  type ServerTokenTier,
} from './nios-calc';
