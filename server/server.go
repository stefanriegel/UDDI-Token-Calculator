package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// NewRouter builds the chi router with:
//   - Middleware: Logger, Recoverer
//   - /api/v1/health → HandleHealth
//   - /* → staticHandler (embedded React SPA)
//
// staticHandler is created by NewStaticHandler and passed in from main.go.
// This separation makes the router testable without a real embed.FS.
func NewRouter(staticHandler http.Handler) *chi.Mux {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", HandleHealth)
	})

	// Static SPA — must come after API routes so /api/v1/* is not caught here
	r.Handle("/*", staticHandler)

	return r
}
