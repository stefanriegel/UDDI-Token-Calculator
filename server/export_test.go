package server_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
	"github.com/infoblox/uddi-go-token-calculator/server"
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
func serveExportRequest(store *session.Store, scanID string, method string) *httptest.ResponseRecorder {
	h := server.NewExportHandler(store)

	req := httptest.NewRequest(method, "/api/v1/scan/"+scanID+"/export", nil)
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
	rec := serveExportRequest(store, "unknown", http.MethodGet)

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

	rec := serveExportRequest(store, sess.ID, http.MethodGet)

	if rec.Code != http.StatusAccepted {
		t.Errorf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleExport_OK asserts that requesting export for a completed scan returns 200
// with Content-Type application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.
func TestHandleExport_OK(t *testing.T) {
	store, scanID := testCompleteSession(t)
	rec := serveExportRequest(store, scanID, http.MethodGet)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	ct := rec.Header().Get("Content-Type")
	want := "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	if ct != want {
		t.Errorf("expected Content-Type %q, got %q", want, ct)
	}
}
