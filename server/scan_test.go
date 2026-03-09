package server_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
	"github.com/infoblox/uddi-go-token-calculator/server"
)

// noopStatic satisfies the NewRouter staticHandler parameter in these tests.
var noopStatic = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	http.NotFound(w, r)
})

// newTestRouter builds a chi router wired with store and orchestrator.
func newTestRouter(store *session.Store, orch *orchestrator.Orchestrator) http.Handler {
	return server.NewRouter(noopStatic, store, orch)
}

// TestHandleStartScan_OK: POST /api/v1/scan with valid sessionId → 202, body {scanId: sessionId}.
func TestHandleStartScan_OK(t *testing.T) {
	store := session.NewStore()
	sess := store.New()

	orch := orchestrator.New(nil) // no scanners needed — zero providers in request
	router := newTestRouter(store, orch)

	body := map[string]interface{}{
		"sessionId": sess.ID,
		"providers": []interface{}{},
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp server.ScanStartResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ScanID != sess.ID {
		t.Errorf("expected scanId=%q, got %q", sess.ID, resp.ScanID)
	}
}

// TestHandleStartScan_NoSession: POST with unknown sessionId → 400, {"error":"session not found"}.
func TestHandleStartScan_NoSession(t *testing.T) {
	store := session.NewStore()
	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	body := map[string]interface{}{
		"sessionId": "doesnotexist",
		"providers": []interface{}{},
	}
	b, _ := json.Marshal(body)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp["error"] == "" {
		t.Error("expected non-empty error field")
	}
}

// TestHandleStartScan_BadBody: POST with malformed JSON → 400.
func TestHandleStartScan_BadBody(t *testing.T) {
	store := session.NewStore()
	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/scan", strings.NewReader("{bad json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

// TestHandleGetScanStatus_Running: POST a scan then GET /status → 200, status="running".
func TestHandleGetScanStatus_Running(t *testing.T) {
	store := session.NewStore()
	sess := store.New()
	sess.State = session.ScanStateScanning

	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/"+sess.ID+"/status", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp server.ScanStatusResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "running" {
		t.Errorf("expected status=running, got %q", resp.Status)
	}
	if resp.Progress != 0 {
		t.Errorf("expected progress=0, got %d", resp.Progress)
	}
	if resp.ScanID != sess.ID {
		t.Errorf("expected scanId=%q, got %q", sess.ID, resp.ScanID)
	}
}

// TestHandleGetScanStatus_NotFound: GET /status with unknown scanId → 404.
func TestHandleGetScanStatus_NotFound(t *testing.T) {
	store := session.NewStore()
	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/notreal/status", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}

// TestHandleScanResults_Running: GET /results while scanning → 202, status:"running".
func TestHandleScanResults_Running(t *testing.T) {
	store := session.NewStore()
	sess := store.New()
	sess.State = session.ScanStateScanning

	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/"+sess.ID+"/results", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp server.ScanResultsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "running" {
		t.Errorf("expected status=running, got %q", resp.Status)
	}
}

// TestHandleScanResults_Complete: GET /results after scan complete → 200, full token breakdown.
func TestHandleScanResults_Complete(t *testing.T) {
	store := session.NewStore()
	sess := store.New()

	now := time.Now()
	sess.State = session.ScanStateComplete
	sess.CompletedAt = &now
	sess.TokenResult = calculator.TokenResult{
		DDITokens:   2,
		IPTokens:    0,
		AssetTokens: 0,
		GrandTotal:  2,
		Findings: []calculator.FindingRow{
			{
				Provider:         "aws",
				Source:           "123456",
				Category:         calculator.CategoryDDIObjects,
				Item:             "vpc",
				Count:            50,
				TokensPerUnit:    calculator.TokensPerDDIObject,
				ManagementTokens: 2,
			},
		},
	}
	sess.Errors = []session.ProviderError{} // no errors

	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/"+sess.ID+"/results", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp server.ScanResultsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Status != "complete" {
		t.Errorf("expected status=complete, got %q", resp.Status)
	}
	if resp.TotalManagementTokens != 2 {
		t.Errorf("expected totalManagementTokens=2, got %d", resp.TotalManagementTokens)
	}
	if resp.DDITokens != 2 {
		t.Errorf("expected ddiTokens=2, got %d", resp.DDITokens)
	}
	if resp.IPTokens != 0 {
		t.Errorf("expected ipTokens=0, got %d", resp.IPTokens)
	}
	if resp.AssetTokens != 0 {
		t.Errorf("expected assetTokens=0, got %d", resp.AssetTokens)
	}
	if len(resp.Findings) != 1 {
		t.Fatalf("expected 1 finding, got %d", len(resp.Findings))
	}
	f := resp.Findings[0]
	if f.Provider != "aws" {
		t.Errorf("expected provider=aws, got %q", f.Provider)
	}
	if f.Count != 50 {
		t.Errorf("expected count=50, got %d", f.Count)
	}
	if f.ManagementTokens != 2 {
		t.Errorf("expected managementTokens=2, got %d", f.ManagementTokens)
	}
	if resp.CompletedAt == "" {
		t.Error("expected non-empty completedAt")
	}
}

// TestHandleScanResults_NotFound: GET /results with unknown scanId → 404.
func TestHandleScanResults_NotFound(t *testing.T) {
	store := session.NewStore()
	orch := orchestrator.New(nil)
	router := newTestRouter(store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/notreal/results", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}
