// Package session defines the in-memory session and credential types used
// throughout the scan lifecycle. Credentials are never serialized to disk;
// the deliberate absence of json struct tags enforces this at the language level.
package session

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/infoblox/uddi-go-token-calculator/internal/broker"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
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
}

// AzureCredentials holds Azure-specific authentication material.
// No json tags — credentials must never be accidentally serialized.
type AzureCredentials struct {
	AuthMethod     string
	TenantID       string
	ClientID       string
	ClientSecret   string
	SubscriptionID string
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
	// CachedTokenSource holds the live OAuth2 token source obtained during browser-oauth
	// validation. The scanner reuses it to avoid triggering a second browser popup.
	CachedTokenSource oauth2.TokenSource
}

// ADCredentials holds Active Directory / WinRM authentication material.
// No json tags — credentials must never be accidentally serialized.
type ADCredentials struct {
	AuthMethod string
	Hosts      []string // One entry per domain controller. Was: Host string (single DC only).
	Username   string
	Password   string
	Domain     string
}

// ProviderError records a per-resource-type failure that occurred during a scan.
// The scan continues for all other providers after an individual error (RES-01).
type ProviderError struct {
	Provider string
	Resource string
	Message  string
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

	AWS   *AWSCredentials
	Azure *AzureCredentials
	GCP   *GCPCredentials
	AD    *ADCredentials

	Errors []ProviderError
	Broker *broker.Broker

	// TokenResult is set by the scan goroutine when the orchestrator finishes.
	// Protected by mu; read only after State == ScanStateComplete.
	TokenResult calculator.TokenResult

	mu sync.RWMutex // guards concurrent access to mutable fields
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
