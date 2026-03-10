package server

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// NewRouter builds the chi router with:
//   - Middleware: Logger (polling status endpoints suppressed), Recoverer
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
	// Suppress logger for polling status endpoint (/api/v1/scan/.../status) — the frontend
	// polls it every 1.5 seconds and it would produce nothing but noise in the console.
	r.Use(func(next http.Handler) http.Handler {
		logger := middleware.Logger
		loggerHandler := logger(next)
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if strings.HasSuffix(req.URL.Path, "/status") {
				next.ServeHTTP(w, req)
				return
			}
			loggerHandler.ServeHTTP(w, req)
		})
	})
	r.Use(middleware.Recoverer)

	validateHandler := NewValidateHandler(store)
	RegisterValidateHandler(r, validateHandler)

	if orch != nil {
		scanHandler := NewScanHandler(store, orch)
		exportHandler := NewExportHandler(store)
		r.Route("/api/v1", func(r chi.Router) {
			r.Get("/health", HandleHealth)
			r.Get("/version", HandleVersion)
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
		})
	}

	// Static SPA — must come after API routes so /api/v1/* is not caught here.
	r.Handle("/*", staticHandler)

	return r
}
