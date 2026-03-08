package server

// HealthResponse is the JSON body for GET /api/v1/health.
type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}
