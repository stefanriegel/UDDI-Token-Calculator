package server

import "encoding/json"

// VersionResponse is the JSON body for GET /api/v1/version.
type VersionResponse struct {
	Version string `json:"version"` // e.g. "v1.0.0-5-gabcdef1" or "dev"
	Commit  string `json:"commit"`  // e.g. "abcdef12" or "none"
}

// HealthResponse is the JSON body for GET /api/v1/health.
type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

// ScanStartRequest is the body for POST /api/v1/scan.
// sessionId references credentials stored by the validate handler.
// Credentials are never re-transmitted in this request.
type ScanStartRequest struct {
	SessionID string            `json:"sessionId"`
	Providers []ScanProviderSpec `json:"providers"`
}

type ScanProviderSpec struct {
	Provider        string   `json:"provider"`
	Subscriptions   []string `json:"subscriptions"`
	SelectionMode   string   `json:"selectionMode"`             // "include" | "exclude"
	SelectedMembers []string `json:"selectedMembers,omitempty"` // NIOS: selected Grid Member hostnames
	// BackupToken is the opaque token returned by HandleUploadNiosBackup.
	// HandleStartScan resolves it to a temp file path via niosBackupTokens sync.Map.
	BackupToken string `json:"backupToken,omitempty"`
}

// ScanStartResponse is returned immediately by POST /api/v1/scan.
// The scanId equals the sessionId — callers use it for /events and /results.
type ScanStartResponse struct {
	ScanID string `json:"scanId"`
}

// FindingRowResponse is one row in the results findings array.
// Matches the FindingRowAPI shape the frontend api-client.ts expects (updated for session model).
type FindingRowResponse struct {
	Provider         string `json:"provider"`
	Source           string `json:"source"`
	Region           string `json:"region"`    // cloud region (e.g. "us-east-1"); empty for global resources
	Category         string `json:"category"`  // "DDI Objects" | "Active IPs" | "Managed Assets"
	Item             string `json:"item"`
	Count            int    `json:"count"`
	TokensPerUnit    int    `json:"tokensPerUnit"`
	ManagementTokens int    `json:"managementTokens"`
}

// ProviderErrorResponse is one entry in the results errors array.
type ProviderErrorResponse struct {
	Provider string `json:"provider"`
	Resource string `json:"resource"`
	Message  string `json:"message"`
}

// ValidateRequest is the body for POST /api/v1/providers/{provider}/validate.
// Credentials are write-once into the session store and must never appear in
// any log statement or response body.
type ValidateRequest struct {
	AuthMethod  string            `json:"authMethod"`
	Credentials map[string]string `json:"credentials"`
}

// SubscriptionItem is one entry in the subscriptions array returned by validate.
type SubscriptionItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ValidateResponse is the response from POST /api/v1/providers/{provider}/validate.
// On success: valid=true, sessionId set in cookie, subscriptions populated.
// On failure: valid=false, error set, no session created.
type ValidateResponse struct {
	Valid         bool               `json:"valid"`
	Error         string             `json:"error,omitempty"`
	Subscriptions []SubscriptionItem `json:"subscriptions"`
}

// CloneSessionResponse is returned by POST /api/v1/session/clone.
// The new session ID should be used for the next scan; the ddi_session cookie
// is also updated by the server so JS does not need to manage it directly.
type CloneSessionResponse struct {
	SessionID string `json:"sessionId"`
}

// ProviderScanStatus is per-provider progress snapshot for the polling endpoint.
type ProviderScanStatus struct {
	Provider   string `json:"provider"`
	Progress   int    `json:"progress"`   // 0–100
	Status     string `json:"status"`     // "pending" | "running" | "complete" | "error"
	ItemsFound int    `json:"itemsFound"` // items discovered so far
}

// ScanStatusResponse is the body for GET /api/v1/scan/{scanId}/status.
type ScanStatusResponse struct {
	ScanID    string               `json:"scanId"`
	Status    string               `json:"status"`    // "running" | "complete"
	Progress  int                  `json:"progress"`  // 0–100 overall (100 = complete)
	Providers []ProviderScanStatus `json:"providers"`
}

// NiosGridMember is one Grid Member returned by the upload endpoint.
type NiosGridMember struct {
	Hostname string `json:"hostname"`
	Role     string `json:"role"` // "Master" | "Candidate" | "Regular"
}

// NiosUploadResponse is the body for POST /api/v1/providers/nios/upload.
type NiosUploadResponse struct {
	Valid        bool             `json:"valid"`
	Error        string           `json:"error,omitempty"`
	GridName     string           `json:"gridName,omitempty"`
	NiosVersion  string           `json:"niosVersion,omitempty"`
	Members      []NiosGridMember `json:"members"`
	// BackupToken is the opaque token the frontend must pass back in the scan-start
	// request body as ScanProviderSpec.BackupToken. HandleStartScan resolves it to
	// the temp file path via the server-side niosBackupTokens sync.Map.
	BackupToken  string           `json:"backupToken,omitempty"`
}

// ScanResultsResponse is the body for GET /api/v1/scan/{id}/results.
type ScanResultsResponse struct {
	ScanID                string                  `json:"scanId"`
	CompletedAt           string                  `json:"completedAt"`    // RFC3339 or "" if still running
	Status                string                  `json:"status"`         // "running" | "complete"
	TotalManagementTokens int                     `json:"totalManagementTokens"`
	DDITokens             int                     `json:"ddiTokens"`
	IPTokens              int                     `json:"ipTokens"`
	AssetTokens           int                     `json:"assetTokens"`
	Findings              []FindingRowResponse    `json:"findings"`
	Errors                []ProviderErrorResponse `json:"errors"`
	// NiosServerMetrics is populated after a NIOS scan completes. It holds JSON-encoded
	// []NiosServerMetric data from the NIOS scanner. Plan 04 will type this as []NiosServerMetric.
	NiosServerMetrics json.RawMessage `json:"niosServerMetrics,omitempty"`
}
