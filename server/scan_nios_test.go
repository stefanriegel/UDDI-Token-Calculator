package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
	"github.com/infoblox/uddi-go-token-calculator/server"
)

// TestHandleScanResultsNIOS verifies that GET /api/v1/scan/{scanId}/results returns
// a niosServerMetrics array when the session has NiosServerMetricsJSON set (API-02).
func TestHandleScanResultsNIOS(t *testing.T) {
	store := session.NewStore()
	sess := store.New()

	now := time.Now()
	sess.State = session.ScanStateComplete
	sess.CompletedAt = &now

	// Encode a single NiosServerMetric into the session field.
	metricsData := []server.NiosServerMetric{
		{
			MemberID:    "gm.test.local",
			MemberName:  "gm.test.local",
			Role:        "GM",
			QPS:         0,
			LPS:         0,
			ObjectCount: 100,
		},
	}
	encoded, err := json.Marshal(metricsData)
	if err != nil {
		t.Fatalf("json.Marshal metricsData: %v", err)
	}
	sess.NiosServerMetricsJSON = encoded

	orch := orchestrator.New(nil)
	router := server.NewRouter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}), store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/"+sess.ID+"/results", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var resp server.ScanResultsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("json.Decode response: %v", err)
	}

	if len(resp.NiosServerMetrics) != 1 {
		t.Fatalf("expected 1 niosServerMetric, got %d", len(resp.NiosServerMetrics))
	}

	m := resp.NiosServerMetrics[0]
	if m.MemberID != "gm.test.local" {
		t.Errorf("NiosServerMetrics[0].MemberID: got %q, want %q", m.MemberID, "gm.test.local")
	}
	if m.Role != "GM" {
		t.Errorf("NiosServerMetrics[0].Role: got %q, want %q", m.Role, "GM")
	}
	if m.ObjectCount != 100 {
		t.Errorf("NiosServerMetrics[0].ObjectCount: got %d, want 100", m.ObjectCount)
	}
}

// TestHandleScanResultsNIOS_Absent verifies that niosServerMetrics is absent from the
// JSON response when NIOS was not included in the scan (omitempty behaviour).
func TestHandleScanResultsNIOS_Absent(t *testing.T) {
	store := session.NewStore()
	sess := store.New()

	now := time.Now()
	sess.State = session.ScanStateComplete
	sess.CompletedAt = &now
	// NiosServerMetricsJSON is nil — NIOS was not scanned.

	orch := orchestrator.New(nil)
	router := server.NewRouter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}), store, orch)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/scan/"+sess.ID+"/results", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Decode into a raw map to check for key absence (omitempty).
	var raw map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&raw); err != nil {
		t.Fatalf("json.Decode response: %v", err)
	}

	if _, present := raw["niosServerMetrics"]; present {
		t.Error("expected niosServerMetrics to be absent from JSON when NIOS was not scanned, but key was present")
	}
}
