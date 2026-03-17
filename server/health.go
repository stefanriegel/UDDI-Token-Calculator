package server

import (
	"encoding/json"
	"net/http"
	"runtime"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/version"
)

// HandleHealth serves GET /api/v1/health.
// The frontend polls this every 8 seconds with a 3-second timeout.
// Returning {"status":"ok","version":"..."} switches the UI from Demo Mode to Connected.
// Version field reflects the build-time ldflags value (or "dev" in local builds).
// Platform reports runtime.GOOS so the frontend can show platform-specific auth options
// (e.g. "Windows SSO" only on windows).
func HandleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(HealthResponse{
		Status:   "ok",
		Version:  version.Version,
		Platform: runtime.GOOS,
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
