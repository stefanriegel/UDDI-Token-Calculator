package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// ScanHandler holds the dependencies required by the scan HTTP handlers.
type ScanHandler struct {
	store        *session.Store
	orchestrator *orchestrator.Orchestrator
}

// NewScanHandler constructs a ScanHandler with the given session store and orchestrator.
func NewScanHandler(store *session.Store, orch *orchestrator.Orchestrator) *ScanHandler {
	return &ScanHandler{store: store, orchestrator: orch}
}

// HandleStartScan handles POST /api/v1/scan.
//
// It decodes the request body, validates the session, marks it as scanning,
// and launches the orchestrator in a background goroutine. The response is
// returned immediately with 202 Accepted and {scanId}.
func (h *ScanHandler) HandleStartScan(w http.ResponseWriter, r *http.Request) {
	var req ScanStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	// Fall back to the httpOnly session cookie when the body omits sessionId.
	// JS cannot read httpOnly cookies, so the frontend sends "" and we resolve it here.
	if req.SessionID == "" {
		if cookie, err := r.Cookie("ddi_session"); err == nil {
			req.SessionID = cookie.Value
		}
	}
	if req.SessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sessionId is required"})
		return
	}

	sess, ok := h.store.Get(req.SessionID)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "session not found"})
		return
	}

	if sess.State != session.ScanStateCreated {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "scan already started for this session"})
		return
	}

	// Transition state before launching the goroutine so concurrent callers
	// see ScanStateScanning and receive 409.
	sess.State = session.ScanStateScanning
	sess.StartedAt = time.Now()

	// Build the orchestrator provider list from the request.
	providers := toOrchestratorProviders(req.Providers)

	// Launch the scan in a background goroutine — this call is non-blocking.
	go func() {
		result := h.orchestrator.Run(context.Background(), sess, providers)

		now := time.Now()
		sess.CompletedAt = &now
		sess.TokenResult = result.TokenResult
		sess.Errors = result.Errors
		sess.State = session.ScanStateComplete
	}()

	writeJSON(w, http.StatusAccepted, ScanStartResponse{ScanID: req.SessionID})
}

// HandleScanEvents handles GET /api/v1/scan/{scanId}/events.
//
// It streams SSE events from the session broker until the broker is closed
// (scan complete) or the client disconnects. A heartbeat is sent every 15 s
// to keep the connection alive through proxies.
func (h *ScanHandler) HandleScanEvents(w http.ResponseWriter, r *http.Request) {
	scanID := chi.URLParam(r, "scanId")

	sess, ok := h.store.Get(scanID)
	if !ok {
		http.Error(w, "scan not found", http.StatusNotFound)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	// Set SSE headers before writing any body.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := sess.Broker.Subscribe()
	defer sess.Broker.Unsubscribe(ch)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case event, open := <-ch:
			if !open {
				// Broker was closed — scan is done. Exit the loop.
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()

		case <-ticker.C:
			fmt.Fprintf(w, "data: {\"type\":\"heartbeat\"}\n\n")
			flusher.Flush()

		case <-r.Context().Done():
			return
		}
	}
}

// HandleScanResults handles GET /api/v1/scan/{scanId}/results.
//
// Returns 202 Accepted with status:"running" while the scan is in progress.
// Returns 200 OK with the full token formula breakdown once the scan completes.
func (h *ScanHandler) HandleScanResults(w http.ResponseWriter, r *http.Request) {
	scanID := chi.URLParam(r, "scanId")

	sess, ok := h.store.Get(scanID)
	if !ok {
		http.Error(w, "scan not found", http.StatusNotFound)
		return
	}

	if sess.State == session.ScanStateScanning || sess.State == session.ScanStateCreated {
		writeJSON(w, http.StatusAccepted, ScanResultsResponse{
			ScanID: scanID,
			Status: "running",
		})
		return
	}

	// Build per-row findings response from the stored token result.
	findings := make([]FindingRowResponse, 0, len(sess.TokenResult.Findings))
	for _, row := range sess.TokenResult.Findings {
		findings = append(findings, FindingRowResponse{
			Provider:         row.Provider,
			Source:           row.Source,
			Category:         row.Category,
			Item:             row.Item,
			Count:            row.Count,
			TokensPerUnit:    row.TokensPerUnit,
			ManagementTokens: row.ManagementTokens,
		})
	}

	// Build per-provider error list.
	errors := make([]ProviderErrorResponse, 0, len(sess.Errors))
	for _, pe := range sess.Errors {
		errors = append(errors, ProviderErrorResponse{
			Provider: pe.Provider,
			Resource: pe.Resource,
			Message:  pe.Message,
		})
	}

	completedAt := ""
	if sess.CompletedAt != nil {
		completedAt = sess.CompletedAt.Format(time.RFC3339)
	}

	writeJSON(w, http.StatusOK, ScanResultsResponse{
		ScanID:                scanID,
		CompletedAt:           completedAt,
		Status:                "complete",
		TotalManagementTokens: sess.TokenResult.GrandTotal,
		DDITokens:             sess.TokenResult.DDITokens,
		IPTokens:              sess.TokenResult.IPTokens,
		AssetTokens:           sess.TokenResult.AssetTokens,
		Findings:              findings,
		Errors:                errors,
	})
}

// toOrchestratorProviders converts the HTTP request provider list to the
// orchestrator's ScanProviderRequest slice.
func toOrchestratorProviders(specs []ScanProviderSpec) []orchestrator.ScanProviderRequest {
	reqs := make([]orchestrator.ScanProviderRequest, 0, len(specs))
	for _, s := range specs {
		reqs = append(reqs, orchestrator.ScanProviderRequest{
			Provider:      s.Provider,
			Subscriptions: s.Subscriptions,
			SelectionMode: s.SelectionMode,
		})
	}
	return reqs
}

// writeJSON encodes v as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
