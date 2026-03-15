package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// NewRouter builds the chi router with:
//   - Middleware: Logger, Recoverer
//   - /api/v1/health → HandleHealth
//   - /api/v1/providers/{provider}/validate → ValidateHandler (credential validation + session creation)
//   - /api/v1/scan → scan lifecycle handlers (start, events, results)
//   - /* → staticHandler (embedded React SPA)
//
// staticHandler is created by NewStaticHandler and passed in from main.go.
// store and orch are wired into the scan and validate handlers.
// This separation makes the router testable without a real embed.FS or live cloud credentials.
// orch may be nil when only the validate handler needs to be exercised (tests).
func NewRouter(staticHandler http.Handler, store *session.Store, orch *orchestrator.Orchestrator) *chi.Mux {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	validateHandler := NewValidateHandler(store)
	RegisterValidateHandler(r, validateHandler)

	if orch != nil {
		scanHandler := NewScanHandler(store, orch)
		r.Route("/api/v1", func(r chi.Router) {
			r.Get("/health", HandleHealth)
			r.Post("/scan", scanHandler.HandleStartScan)
			r.Get("/scan/{scanId}/events", scanHandler.HandleScanEvents)
			r.Get("/scan/{scanId}/results", scanHandler.HandleScanResults)
		})
	} else {
		r.Route("/api/v1", func(r chi.Router) {
			r.Get("/health", HandleHealth)
		})
	}

	// Static SPA — must come after API routes so /api/v1/* is not caught here.
	r.Handle("/*", staticHandler)

	return r
}
