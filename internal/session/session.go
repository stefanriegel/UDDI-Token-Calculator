// Package session defines the in-memory session and credential types used
// throughout the scan lifecycle. Credentials are never serialized to disk;
// the deliberate absence of json struct tags enforces this at the language level.
package session

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/broker"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"golang.org/x/oauth2"
)

// ScanState is a string type so log messages are human-readable without a lookup table.
type ScanState string

const (
	ScanStateCreated  ScanState = "created"
	ScanStateScanning ScanState = "scanning"
	ScanStateComplete ScanState = "complete"
	ScanStateFailed   ScanState = "failed"
)

// AWSCredentials holds AWS-specific authentication material.
// No json tags — credentials must never be accidentally serialized.
type AWSCredentials struct {
	AuthMethod      string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	Region          string
	ProfileName     string
	RoleARN         string
	SSOStartURL     string
	SSORegion       string
	// SSOAccessToken is the short-lived OIDC access token obtained during the
	// SSO device-authorization flow in the validate handler. It is used by the
	// scanner to call sso:GetRoleCredentials, which exchanges it for temporary
	// STS credentials without requiring a local ~/.aws/config SSO profile.
	SSOAccessToken string
	// SourceProfile is the AWS CLI profile used as the base credentials for
	// assume-role authentication. Defaults to "default" if not specified.
	SourceProfile string
	// ExternalID is the STS external ID for cross-account assume-role.
	// Only sent to STS when non-empty.
	ExternalID string
	// OrgEnabled indicates that Organizations multi-account scanning is active.
	// When true, the scanner fans out per-account using AssumeRole.
	OrgEnabled bool
	// OrgRoleName is the IAM role name assumed in each child account during
	// org-mode scanning (e.g. "OrganizationAccountAccessRole").
	OrgRoleName string
}

// AzureCredentials holds Azure-specific authentication material.
// No json tags — credentials must never be accidentally serialized.
type AzureCredentials struct {
	AuthMethod     string
	TenantID       string
	ClientID       string
	ClientSecret   string
	SubscriptionID string
	// CertificateData holds base64-encoded or raw PEM certificate content
	// for certificate-based Service Principal authentication.
	CertificateData string
	// CertificatePassword holds the optional password for encrypted private keys.
	CertificatePassword string
	// CachedCredential holds the live token credential obtained during browser-SSO
	// validation. It must never be serialized (no json tag). When non-nil the scanner
	// reuses it, preventing a second browser popup.
	CachedCredential azcore.TokenCredential
}

// GCPCredentials holds GCP-specific authentication material.
// No json tags — credentials must never be accidentally serialized.
type GCPCredentials struct {
	AuthMethod         string
	ServiceAccountJSON string
	ProjectID          string
	// WorkloadIdentityJSON holds the WIF configuration JSON for external_account auth.
	// Distinct from ServiceAccountJSON to avoid overloading the same field.
	WorkloadIdentityJSON string
	// OrgID is the GCP organization ID for org-mode scanning (e.g. "123456789").
	// When set, the scanner discovers all projects in the org and fans out per-project.
	OrgID string
	// CachedTokenSource holds the live OAuth2 token source obtained during browser-oauth
	// or ADC validation. The scanner reuses it to avoid triggering a second browser popup.
	CachedTokenSource oauth2.TokenSource
}

// ADCredentials holds Active Directory / WinRM authentication material.
// No json tags — credentials must never be accidentally serialized.
type ADCredentials struct {
	AuthMethod         string
	Hosts              []string // One entry per domain controller. Was: Host string (single DC only).
	Username           string
	Password           string
	Domain             string
	UseSSL             bool
	InsecureSkipVerify bool
	// Kerberos-specific fields (pure Go via gokrb5, not Windows SSPI).
	Realm string // Kerberos realm (e.g. "CORP.EXAMPLE.COM")
	KDC   string // Key Distribution Center address (e.g. "dc01.corp.example.com:88")
	// EventLogWindowHours controls how far back event log extraction goes.
	// Default 72 (3 days). Valid values: 1, 24, 72, 168 (7 days).
	EventLogWindowHours int
}

// BluecatCredentials holds Bluecat Address Manager authentication material.
// No json tags — credentials must never be accidentally serialized.
type BluecatCredentials struct {
	URL              string
	Username         string
	Password         string
	SkipTLS          bool
	ConfigurationIDs []string // optional config ID filter
}

// EfficientIPCredentials holds EfficientIP SOLIDserver authentication material.
// No json tags — credentials must never be accidentally serialized.
type EfficientIPCredentials struct {
	URL         string
	Username    string
	Password    string
	SkipTLS     bool
	SiteIDs     []string // optional site ID filter
	AuthMethod  string   // "credentials" or "token"
	TokenID     string   // API token ID (when AuthMethod == "token")
	TokenSecret string   // API token secret (when AuthMethod == "token")
	APIVersion  string   // "legacy" or "v2"
}

// NiosWAPICredentials holds NIOS WAPI live scanner authentication material.
// No json tags — credentials must never be accidentally serialized.
type NiosWAPICredentials struct {
	URL             string
	Username        string
	Password        string
	SkipTLS         bool
	ExplicitVersion string // optional WAPI version override
}

// ProviderError records a per-resource-type failure that occurred during a scan.
// The scan continues for all other providers after an individual error (RES-01).
type ProviderError struct {
	Provider string
	Resource string
	Message  string
}

// ProviderProgressInfo tracks real-time progress for a single provider during a scan.
type ProviderProgressInfo struct {
	Status     string // "pending" | "running" | "complete" | "error"
	Progress   int    // 0–100
	ItemsFound int
}

// Session holds the lifecycle state of a single scan request.
// No json tags on any field — sessions should never be marshaled to disk.
// Credential fields are nilled via ZeroCreds() once the scan goroutine has
// received them, reducing the in-memory credential window.
type Session struct {
	ID          string
	State       ScanState
	StartedAt   time.Time
	CompletedAt *time.Time

	AWS         *AWSCredentials
	Azure       *AzureCredentials
	GCP         *GCPCredentials
	AD          *ADCredentials
	// ADForests holds credentials for additional AD forests (index 1, 2, ...).
	// ADForests[0] is never used — the primary forest is always in AD.
	// When non-empty the orchestrator fans out across AD + each ADForest entry.
	ADForests   []ADCredentials
	Bluecat     *BluecatCredentials
	EfficientIP *EfficientIPCredentials
	NiosWAPI    *NiosWAPICredentials

	Errors []ProviderError
	Broker *broker.Broker

	// TokenResult is set by the scan goroutine when the orchestrator finishes.
	// Protected by mu; read only after State == ScanStateComplete.
	TokenResult calculator.TokenResult

	// NiosServerMetricsJSON holds JSON-encoded []NiosServerMetric from the NIOS scan.
	// Stored as raw bytes to avoid an import cycle with internal/scanner/nios.
	// nil if NIOS was not scanned.
	NiosServerMetricsJSON []byte

	// NiosGridFeaturesJSON holds JSON-encoded NiosGridFeatures from the NIOS scan.
	// nil if NIOS was not scanned.
	NiosGridFeaturesJSON []byte

	// NiosGridLicensesJSON holds JSON-encoded NiosGridLicenses from the NIOS scan.
	// nil if NIOS was not scanned.
	NiosGridLicensesJSON []byte

	// ADServerMetricsJSON holds JSON-encoded []ADServerMetric from the AD scan.
	// Stored as raw bytes to avoid an import cycle with internal/scanner/ad.
	// nil if AD was not scanned.
	ADServerMetricsJSON []byte

	// NiosMigrationFlagsJSON holds JSON-encoded NiosMigrationFlags from the NIOS scan.
	// Contains DHCP option flags and /32 host route flags for migration readiness.
	// nil if NIOS was not scanned or no flags were found.
	NiosMigrationFlagsJSON []byte

	// NiosQPSDataJSON holds JSON-encoded map[string]float64 of peak QPS per member hostname.
	// Parsed from Splunk XML upload. nil if no QPS data was uploaded.
	NiosQPSDataJSON []byte

	// ProviderProgress tracks per-provider scan progress for the polling endpoint.
	// Keys are provider names ("aws", "azure", "gcp", "ad", "nios").
	// Updated by the orchestrator goroutine, read by HandleGetScanStatus.
	ProviderProgress map[string]*ProviderProgressInfo

	mu sync.RWMutex // guards concurrent access to mutable fields
}

// SetNiosServerMetricsJSON stores the JSON-encoded NIOS server metrics in the session.
// Called by the orchestrator after a successful NIOS scan.
// Uses the session mutex to guard concurrent access.
func (s *Session) SetNiosServerMetricsJSON(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.NiosServerMetricsJSON = data
}

// SetNiosGridFeaturesJSON stores the JSON-encoded NIOS grid features in the session.
func (s *Session) SetNiosGridFeaturesJSON(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.NiosGridFeaturesJSON = data
}

// SetNiosGridLicensesJSON stores the JSON-encoded NIOS grid licenses in the session.
func (s *Session) SetNiosGridLicensesJSON(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.NiosGridLicensesJSON = data
}

// SetADServerMetricsJSON stores the JSON-encoded AD server metrics in the session.
// Called by the orchestrator after a successful AD scan.
// Uses the session mutex to guard concurrent access.
func (s *Session) SetADServerMetricsJSON(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ADServerMetricsJSON = data
}

// SetNiosMigrationFlagsJSON stores the JSON-encoded NIOS migration flags in the session.
// Called by the orchestrator after a successful NIOS backup scan.
// Uses the session mutex to guard concurrent access.
func (s *Session) SetNiosMigrationFlagsJSON(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.NiosMigrationFlagsJSON = data
}

// SetNiosQPSDataJSON stores the JSON-encoded peak QPS per member data in the session.
// Called when the user uploads a Splunk QPS XML file.
// Uses the session mutex to guard concurrent access.
func (s *Session) SetNiosQPSDataJSON(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.NiosQPSDataJSON = data
}

// UpdateProviderProgress sets the progress info for a single provider.
// Thread-safe — called from orchestrator goroutines.
func (s *Session) UpdateProviderProgress(provider, status string, progress, itemsFound int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ProviderProgress == nil {
		s.ProviderProgress = make(map[string]*ProviderProgressInfo)
	}
	s.ProviderProgress[provider] = &ProviderProgressInfo{
		Status:     status,
		Progress:   progress,
		ItemsFound: itemsFound,
	}
}

// GetProviderProgress returns a snapshot copy of all provider progress info.
// Thread-safe — called from HTTP handler goroutines.
func (s *Session) GetProviderProgress() map[string]*ProviderProgressInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.ProviderProgress == nil {
		return nil
	}
	cp := make(map[string]*ProviderProgressInfo, len(s.ProviderProgress))
	for k, v := range s.ProviderProgress {
		info := *v // copy the struct
		cp[k] = &info
	}
	return cp
}

// ZeroCreds nils all credential pointer fields. Call this once the scan
// goroutine has copied the credentials it needs so they are not retained in
// memory longer than necessary.
func (s *Session) ZeroCreds() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.AWS = nil
	s.Azure = nil
	s.GCP = nil
	s.AD = nil
	s.ADForests = nil
	s.Bluecat = nil
	s.EfficientIP = nil
	s.NiosWAPI = nil
}

// safeSession is a sanitized view of Session used for JSON marshaling.
// Credential pointer fields are deliberately excluded — they must never appear
// in any serialized output (logs, HTTP responses, disk writes).
type safeSession struct {
	ID          string         `json:"id"`
	State       ScanState      `json:"state"`
	StartedAt   time.Time      `json:"started_at"`
	CompletedAt *time.Time     `json:"completed_at,omitempty"`
	Errors      []ProviderError `json:"errors,omitempty"`
}

// MarshalJSON implements json.Marshaler. It returns a sanitized JSON
// representation that omits all credential fields, preventing accidental
// credential leakage through serialization.
func (s *Session) MarshalJSON() ([]byte, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	safe := safeSession{
		ID:          s.ID,
		State:       s.State,
		StartedAt:   s.StartedAt,
		CompletedAt: s.CompletedAt,
		Errors:      s.Errors,
	}
	return json.Marshal(safe)
}
