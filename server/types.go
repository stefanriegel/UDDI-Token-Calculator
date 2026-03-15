package server

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
	// Mode selects the NIOS scan mode: "backup" (default) or "wapi" (live WAPI).
	Mode string `json:"mode,omitempty"`
}

// ScanStartResponse is returned immediately by POST /api/v1/scan.
// The scanId equals the sessionId — callers use it for /status and /results.
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

// NiosServerMetric is per-Grid-Member performance data returned in the results
// when the NIOS provider was included in a scan. See API_CONTRACT.md §6.
type NiosServerMetric struct {
	MemberID    string `json:"memberId"`
	MemberName  string `json:"memberName"`
	Role        string `json:"role"`
	QPS         int    `json:"qps"`
	LPS         int    `json:"lps"`
	ObjectCount int    `json:"objectCount"`
}

// BluecatValidateResponse is the response from Bluecat credential validation.
type BluecatValidateResponse struct {
	Valid      bool   `json:"valid"`
	Error      string `json:"error,omitempty"`
	APIVersion string `json:"apiVersion,omitempty"` // "v1" or "v2"
}

// EfficientIPValidateResponse is the response from EfficientIP credential validation.
type EfficientIPValidateResponse struct {
	Valid    bool   `json:"valid"`
	Error    string `json:"error,omitempty"`
	AuthMode string `json:"authMode,omitempty"` // "basic" or "native"
}

// NiosWAPIValidateResponse is the response from NIOS WAPI credential validation.
type NiosWAPIValidateResponse struct {
	Valid       bool             `json:"valid"`
	Error       string           `json:"error,omitempty"`
	Members     []NiosGridMember `json:"members,omitempty"`
	WAPIVersion string           `json:"wapiVersion,omitempty"`
}

// UpdateCheckResponse is the JSON body for GET /api/v1/update/check.
type UpdateCheckResponse struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	ReleaseURL      string `json:"releaseURL,omitempty"`
	ReleaseNotes    string `json:"releaseNotes,omitempty"`
	DownloadURL     string `json:"downloadURL,omitempty"`
}

// SelfUpdateResponse is the JSON body for POST /api/v1/update/apply.
type SelfUpdateResponse struct {
	Success        bool   `json:"success"`
	Error          string `json:"error,omitempty"`
	Message        string `json:"message,omitempty"`
	RestartPending bool   `json:"restartPending,omitempty"`
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
	// NiosServerMetrics is populated when the nios provider was scanned.
	// Omitted from the response when NIOS was not included in the scan.
	NiosServerMetrics []NiosServerMetric `json:"niosServerMetrics,omitempty"`
}
