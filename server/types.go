package server

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
	Provider      string   `json:"provider"`
	Subscriptions []string `json:"subscriptions"`
	SelectionMode string   `json:"selectionMode"` // "include" | "exclude"
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
}
