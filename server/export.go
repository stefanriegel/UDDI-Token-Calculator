package server

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// ExportHandler holds the dependencies required by the export HTTP handler.
type ExportHandler struct {
	store *session.Store
}

// NewExportHandler constructs an ExportHandler with the given session store.
func NewExportHandler(store *session.Store) *ExportHandler {
	return &ExportHandler{store: store}
}

// HandleExport handles GET /api/v1/scan/{scanId}/export.
// TODO: implement in Plan 03.
func (h *ExportHandler) HandleExport(w http.ResponseWriter, r *http.Request) {
	_ = chi.URLParam(r, "scanId")
	http.Error(w, "not implemented", http.StatusNotImplemented)
}
