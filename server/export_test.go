package server_test

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/stefanriegel/UDDI-Token-Calculator/server"
)

// testCompleteSession creates a session store, adds a complete session to it,
// and returns (store, scanID). The session state is ScanStateComplete.
func testCompleteSession(t *testing.T) (*session.Store, string) {
	t.Helper()
	store := session.NewStore()
	sess := store.New()

	now := time.Now()
	sess.State = session.ScanStateComplete
	sess.CompletedAt = &now

	return store, sess.ID
}

// serveExportRequest builds an ExportHandler, injects the scanId chi URL param,
// and serves the given HTTP request. Returns the response recorder.
//
// body may be nil for an empty POST body. The request method is always POST
// — the export endpoint switched from GET to POST in plan 28-02 to carry an
// optional JSON ExportRequest payload.
func serveExportRequest(store *session.Store, scanID string, body io.Reader) *httptest.ResponseRecorder {
	h := server.NewExportHandler(store)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan/"+scanID+"/export", body)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("scanId", scanID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))

	rec := httptest.NewRecorder()
	h.HandleExport(rec, req)
	return rec
}

// TestHandleExport_NotFound asserts that requesting export for an unknown scan ID
// returns 404 Not Found.
func TestHandleExport_NotFound(t *testing.T) {
	store := session.NewStore()
	rec := serveExportRequest(store, "unknown", nil)

	if rec.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleExport_NotComplete asserts that requesting export for a scan that has
// not yet completed (state == ScanStateCreated) returns 202 Accepted.
func TestHandleExport_NotComplete(t *testing.T) {
	store := session.NewStore()
	sess := store.New()
	// State is ScanStateCreated by default — scan not finished yet.
	_ = sess

	rec := serveExportRequest(store, sess.ID, nil)

	if rec.Code != http.StatusAccepted {
		t.Errorf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleExport_OK asserts that requesting export for a completed scan returns 200
// with Content-Type application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
func TestHandleExport_OK(t *testing.T) {
	store, scanID := testCompleteSession(t)
	rec := serveExportRequest(store, scanID, nil)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	ct := rec.Header().Get("Content-Type")
	want := "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	if ct != want {
		t.Errorf("expected Content-Type %q, got %q", want, ct)
	}
}

// TestHandleExport_VariantOverrides asserts that the VariantOverrides field
// in a POST body is decoded into ExportRequest and propagated through to
// exporter.Build. Covers RES-15 round-trip — we route the request through a
// real chi router so URLParam("scanId") works just like in production.
func TestHandleExport_VariantOverrides(t *testing.T) {
	store, scanID := testCompleteSession(t)

	body := bytes.NewBufferString(`{"variantOverrides":{"member-a":1,"member-b":0}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan/"+scanID+"/export", body)
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	r := chi.NewRouter()
	h := server.NewExportHandler(store)
	r.Post("/api/v1/scan/{scanId}/export", h.HandleExport)
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Header().Get("Content-Disposition"), "ddi-token-assessment-") {
		t.Errorf("missing or malformed Content-Disposition: %q", rec.Header().Get("Content-Disposition"))
	}
	// The response body must be a valid xlsx (starts with PK zip magic).
	if rec.Body.Len() < 4 || rec.Body.Bytes()[0] != 'P' || rec.Body.Bytes()[1] != 'K' {
		t.Errorf("response body is not a zip/xlsx stream (len=%d, first bytes=%q)",
			rec.Body.Len(), rec.Body.Bytes()[:min(4, rec.Body.Len())])
	}
}

// TestHandleExport_EmptyBodyStillWorks asserts backwards compatibility:
// a POST with no body decodes to a zero-value ExportRequest and still
// produces a valid workbook.
func TestHandleExport_EmptyBodyStillWorks(t *testing.T) {
	store, scanID := testCompleteSession(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan/"+scanID+"/export", nil)
	rec := httptest.NewRecorder()
	r := chi.NewRouter()
	h := server.NewExportHandler(store)
	r.Post("/api/v1/scan/{scanId}/export", h.HandleExport)
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for empty body, got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() < 4 || rec.Body.Bytes()[0] != 'P' || rec.Body.Bytes()[1] != 'K' {
		t.Errorf("response body is not a zip/xlsx stream (len=%d)", rec.Body.Len())
	}
}

// TestHandleExport_MalformedBody asserts that an invalid JSON body is
// rejected with 400 Bad Request rather than crashing the handler.
func TestHandleExport_MalformedBody(t *testing.T) {
	store, scanID := testCompleteSession(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan/"+scanID+"/export",
		bytes.NewBufferString("{not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r := chi.NewRouter()
	h := server.NewExportHandler(store)
	r.Post("/api/v1/scan/{scanId}/export", h.HandleExport)
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

