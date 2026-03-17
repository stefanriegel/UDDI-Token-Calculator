package server

import (
	"encoding/json"
	"net/http"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/version"
)

// HandleHealth serves GET /api/v1/health.
// The frontend polls this every 8 seconds with a 3-second timeout.
// Returning {"status":"ok","version":"..."} switches the UI from Demo Mode to Connected.
// Version field reflects the build-time ldflags value (or "dev" in local builds).
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(HealthResponse{
		Status:  "ok",
		Version: version.Version,
	})
}

// HandleVersion serves GET /api/v1/version.
// Returns version string and short commit SHA injected at build time via ldflags.
// Frontend footer reads this once on load for traceability.
func HandleVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(VersionResponse{
		Version: version.Version,
		Commit:  version.Commit,
	})
}
