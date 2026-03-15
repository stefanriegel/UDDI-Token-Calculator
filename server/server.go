package server

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// silentPaths are request paths that should not produce log output.
// These are either high-frequency polling endpoints or static assets
// that add nothing but noise to the console.
var silentPaths = map[string]bool{
	"/api/v1/health":       true,
	"/api/v1/update/check": true,
	"/api/v1/version":      true,
}

// shouldLog returns true if this request is worth logging.
func shouldLog(path string) bool {
	// Suppress scan status polling (e.g. /api/v1/scan/{id}/status)
	if strings.HasSuffix(path, "/status") {
		return false
	}
	// Suppress known noisy endpoints
	if silentPaths[path] {
		return false
	}
	// Suppress static asset requests (CSS, JS, SVG, images, favicon)
	if !strings.HasPrefix(path, "/api/") {
		return false
	}
	return true
}

// requestLogger is a minimal chi middleware that logs only meaningful
// API requests: validations, scans, updates, exports. Static assets,
// health polls, and status polls are suppressed to keep console output clean.
func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !shouldLog(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}

		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		start := time.Now()

		next.ServeHTTP(ww, r)

		status := ww.Status()
		dur := time.Since(start)

		if status >= 400 {
			log.Printf("⚠ %s %s → %d (%s)", r.Method, r.URL.Path, status, dur.Round(time.Millisecond))
		} else {
			log.Printf("  %s %s → %d (%s)", r.Method, r.URL.Path, status, dur.Round(time.Millisecond))
		}
	})
}

// NewRouter builds the chi router with:
//   - Middleware: requestLogger (only meaningful API calls), Recoverer
//   - /api/v1/health → HandleHealth
//   - /api/v1/providers/{provider}/validate → ValidateHandler (credential validation + session creation)
//   - /api/v1/scan → scan lifecycle handlers (start, status, results)
//   - /api/v1/providers/nios/upload → HandleUploadNiosBackup
//   - /* → staticHandler (embedded React SPA)
//
// staticHandler is created by NewStaticHandler and passed in from main.go.
// store and orch are wired into the scan and validate handlers.
// This separation makes the router testable without a real embed.FS or live cloud credentials.
// orch may be nil when only the validate handler needs to be exercised (tests).
func NewRouter(staticHandler http.Handler, store *session.Store, orch *orchestrator.Orchestrator) *chi.Mux {
	r := chi.NewRouter()
	r.Use(requestLogger)
	r.Use(middleware.Recoverer)

	validateHandler := NewValidateHandler(store)
	RegisterValidateHandler(r, validateHandler)

	if orch != nil {
		scanHandler := NewScanHandler(store, orch)
		exportHandler := NewExportHandler(store)
		r.Route("/api/v1", func(r chi.Router) {
			r.Get("/health", HandleHealth)
			r.Get("/version", HandleVersion)
			r.Get("/update/check", HandleCheckUpdate)
			r.Post("/update/apply", HandleSelfUpdate)
			r.Post("/update/restart", HandleRestart)
			r.Post("/scan", scanHandler.HandleStartScan)
			r.Get("/scan/{scanId}/status", scanHandler.HandleGetScanStatus)
			r.Get("/scan/{scanId}/results", scanHandler.HandleScanResults)
			r.Get("/scan/{scanId}/export", exportHandler.HandleExport)
			r.Post("/session/clone", scanHandler.HandleCloneSession)
			r.Post("/providers/nios/upload", scanHandler.HandleUploadNiosBackup)
		})
	} else {
		r.Route("/api/v1", func(r chi.Router) {
			r.Get("/health", HandleHealth)
			r.Get("/version", HandleVersion)
			r.Get("/update/check", HandleCheckUpdate)
			r.Post("/update/apply", HandleSelfUpdate)
			r.Post("/update/restart", HandleRestart)
		})
	}

	// Static SPA — must come after API routes so /api/v1/* is not caught here.
	r.Handle("/*", staticHandler)

	return r
}
