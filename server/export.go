package server

import (
	"bytes"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/infoblox/uddi-go-token-calculator/internal/exporter"
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
// Returns 404 if the scan ID is unknown, 202 if the scan is not yet complete,
// or 200 with the xlsx workbook as an attachment if the scan is complete.
func (h *ExportHandler) HandleExport(w http.ResponseWriter, r *http.Request) {
	scanID := chi.URLParam(r, "scanId")

	sess, ok := h.store.Get(scanID)
	if !ok {
		http.Error(w, "scan not found", http.StatusNotFound)
		return
	}

	if sess.State != session.ScanStateComplete {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "scan not complete"})
		return
	}

	var buf bytes.Buffer
	if err := exporter.Build(&buf, sess); err != nil {
		http.Error(w, "export failed", http.StatusInternalServerError)
		return
	}

	date := "unknown"
	if sess.CompletedAt != nil {
		date = sess.CompletedAt.Format("2006-01-02")
	}
	filename := "ddi-token-assessment-" + date + ".xlsx"

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	w.Header().Set("Cache-Control", "no-store")
	io.Copy(w, &buf) //nolint:errcheck
}
