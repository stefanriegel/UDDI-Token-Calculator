package server

import (
	"encoding/json"
	"net/http"
)

const version = "0.1.0"

// HandleHealth serves GET /api/v1/health.
// The frontend polls this every 8 seconds with a 3-second timeout.
// Returning {"status":"ok","version":"0.1.0"} switches the UI from Demo Mode to Connected.
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(HealthResponse{
		Status:  "ok",
		Version: version,
	})
}
