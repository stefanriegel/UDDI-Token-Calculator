package server

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner/nios"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// niosBackupTokens maps opaque upload tokens to temp file paths.
// Entries are removed when HandleStartScan consumes them via LoadAndDelete.
var niosBackupTokens sync.Map

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

// HandleGetScanStatus handles GET /api/v1/scan/{scanId}/status.
//
// Returns a polling-friendly JSON snapshot of the scan progress.
// Returns 404 for an unknown scanId.
// Returns status="running" with progress=0 while the scan is in progress.
// Returns status="complete" with progress=100 once the scan finishes.
// The providers slice is empty for Phase 9; Phase 10 will populate per-provider progress.
func (h *ScanHandler) HandleGetScanStatus(w http.ResponseWriter, r *http.Request) {
	scanID := chi.URLParam(r, "scanId")

	sess, ok := h.store.Get(scanID)
	if !ok {
		http.Error(w, "scan not found", http.StatusNotFound)
		return
	}

	resp := ScanStatusResponse{
		ScanID:    scanID,
		Providers: []ProviderScanStatus{},
	}

	if sess.State == session.ScanStateComplete {
		resp.Status = "complete"
		resp.Progress = 100
	} else {
		resp.Status = "running"
		resp.Progress = 0
	}

	writeJSON(w, http.StatusOK, resp)
}

// HandleUploadNiosBackup handles POST /api/v1/providers/nios/upload.
//
// Accepts a multipart form upload with a "file" field containing a .tar.gz, .tgz, or .bak
// NIOS backup file (max 500 MB). Parses the embedded onedb.xml to extract Grid Member
// hostnames and service roles. Writes the file to os.TempDir and returns an opaque
// BackupToken that the frontend must pass back in the scan-start request.
// Also creates a new session and sets the ddi_session cookie so the subsequent
// POST /api/v1/scan can find the session (same flow as validate for other providers).
func (h *ScanHandler) HandleUploadNiosBackup(w http.ResponseWriter, r *http.Request) {
	// Limit the entire request body to 500 MB before parsing.
	r.Body = http.MaxBytesReader(w, r.Body, 500<<20)

	if err := r.ParseMultipartForm(500 << 20); err != nil {
		if strings.Contains(err.Error(), "request body too large") || strings.Contains(err.Error(), "http: request body too large") {
			http.Error(w, "file too large (max 500 MB)", http.StatusRequestEntityTooLarge)
			return
		}
		writeJSON(w, http.StatusBadRequest, NiosUploadResponse{Valid: false, Error: "failed to parse multipart form: " + err.Error(), Members: []NiosGridMember{}})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, NiosUploadResponse{Valid: false, Error: "missing file field", Members: []NiosGridMember{}})
		return
	}
	defer file.Close()

	name := strings.ToLower(header.Filename)
	if !strings.HasSuffix(name, ".tar.gz") && !strings.HasSuffix(name, ".tgz") && !strings.HasSuffix(name, ".bak") {
		writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: "unsupported file type: must be .tar.gz, .tgz, or .bak", Members: []NiosGridMember{}})
		return
	}

	members, err := parseNiosBackup(file)
	if err != nil {
		writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: err.Error(), Members: []NiosGridMember{}})
		return
	}

	// Seek the multipart file back to the start so we can write it to a temp file.
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeJSON(w, http.StatusInternalServerError, NiosUploadResponse{Valid: false, Error: "failed to seek uploaded file: " + err.Error(), Members: []NiosGridMember{}})
		return
	}

	// Write to temp file so the NIOS scanner can do two-pass streaming later.
	tmp, err := os.CreateTemp("", "nios-backup-*.tar.gz")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, NiosUploadResponse{Valid: false, Error: "failed to create temp file: " + err.Error(), Members: []NiosGridMember{}})
		return
	}
	if _, err := io.Copy(tmp, file); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusInternalServerError, NiosUploadResponse{Valid: false, Error: "failed to write temp file: " + err.Error(), Members: []NiosGridMember{}})
		return
	}
	tmp.Close()

	// Generate an opaque token keyed by upload timestamp.
	token := fmt.Sprintf("%d", time.Now().UnixNano())
	niosBackupTokens.Store(token, tmp.Name())

	// Create a session so POST /api/v1/scan can find it via the ddi_session cookie.
	// This mirrors what validate.go does for other providers.
	sess := h.store.New()
	http.SetCookie(w, &http.Cookie{
		Name:     "ddi_session",
		Value:    sess.ID,
		HttpOnly: true,
		Secure:   false,
		SameSite: http.SameSiteStrictMode,
		Path:     "/",
		MaxAge:   3600,
	})

	writeJSON(w, http.StatusOK, NiosUploadResponse{
		Valid:       true,
		Members:     members,
		BackupToken: token,
	})
}

// parseNiosBackup reads a gzip+tar archive (regardless of extension) and extracts
// Grid Member information from the embedded onedb.xml file.
func parseNiosBackup(r io.Reader) ([]NiosGridMember, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("not a valid gzip archive: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("error reading archive: %w", err)
		}

		if filepath.Base(hdr.Name) != "onedb.xml" {
			continue
		}

		// Found onedb.xml — parse it.
		return parseOneDBXML(tr)
	}

	return nil, fmt.Errorf("no onedb.xml found in backup")
}

// parseOneDBXML extracts Grid Member records from a NIOS onedb.xml stream.
// Uses token-based XML parsing to collect PROPERTY elements (NAME/VALUE attributes)
// for each OBJECT. Member objects are identified by __type=".com.infoblox.one.virtual_node".
func parseOneDBXML(r io.Reader) ([]NiosGridMember, error) {
	var members []NiosGridMember

	decoder := xml.NewDecoder(r)
	var currentProps map[string]string
	inObject := false

	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("XML parse error: %w", err)
		}

		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "OBJECT":
				inObject = true
				currentProps = make(map[string]string)
			case "PROPERTY":
				if !inObject {
					continue
				}
				var name, value string
				for _, attr := range t.Attr {
					switch attr.Name.Local {
					case "NAME":
						name = attr.Value
					case "VALUE":
						value = attr.Value
					}
				}
				if name != "" {
					currentProps[name] = value
				}
			}
		case xml.EndElement:
			if t.Name.Local == "OBJECT" && inObject {
				inObject = false
				if m, ok := objectToMember(currentProps); ok {
					members = append(members, m)
				}
				currentProps = nil
			}
		}
	}

	return members, nil
}

// objectToMember converts a PROPERTY map from an OBJECT element into a NiosGridMember if it
// represents a Grid Member (virtual_node). Returns (member, true) on success, (_, false) otherwise.
func objectToMember(props map[string]string) (NiosGridMember, bool) {
	if props == nil {
		return NiosGridMember{}, false
	}

	// Only process objects with __type = ".com.infoblox.one.virtual_node".
	if props["__type"] != ".com.infoblox.one.virtual_node" {
		return NiosGridMember{}, false
	}

	hostname := props["host_name"]
	if hostname == "" {
		return NiosGridMember{}, false
	}

	// Use service-based roles (not structural Master/Candidate/Regular).
	role := nios.ExportedExtractServiceRole(props)

	return NiosGridMember{Hostname: hostname, Role: role}, true
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
			Region:           row.Region,
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

	// Decode NiosServerMetricsJSON if a NIOS scan was performed.
	var niosMetrics []NiosServerMetric
	if len(sess.NiosServerMetricsJSON) > 0 {
		if err := json.Unmarshal(sess.NiosServerMetricsJSON, &niosMetrics); err != nil {
			// Non-fatal: log to stderr and continue without metrics.
			fmt.Fprintf(os.Stderr, "server: failed to decode NiosServerMetricsJSON: %v\n", err)
			niosMetrics = nil
		}
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
		NiosServerMetrics:     niosMetrics, // nil → omitted by omitempty
	})
}

// HandleCloneSession handles POST /api/v1/session/clone.
//
// It reads the current "ddi_session" cookie, clones that session's credentials
// into a fresh ScanStateCreated session, sets a new ddi_session cookie, and
// returns {"sessionId": newID}.
//
// Live token objects (azcore.TokenCredential, oauth2.TokenSource) are shared
// between the old and new sessions so SSO/browser-OAuth providers do not trigger
// a second browser popup on re-scan.
func (h *ScanHandler) HandleCloneSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("ddi_session")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "no active session"})
		return
	}

	newSess, ok := h.store.CloneSession(cookie.Value)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "session not found"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "ddi_session",
		Value:    newSess.ID,
		HttpOnly: true,
		Secure:   false, // localhost — HTTPS not applicable
		SameSite: http.SameSiteStrictMode,
		Path:     "/",
		MaxAge:   3600,
	})

	writeJSON(w, http.StatusOK, CloneSessionResponse{SessionID: newSess.ID})
}

// toOrchestratorProviders converts the HTTP request provider list to the
// orchestrator's ScanProviderRequest slice.
// For NIOS providers, resolves the BackupToken to a temp file path via niosBackupTokens.
func toOrchestratorProviders(specs []ScanProviderSpec) []orchestrator.ScanProviderRequest {
	reqs := make([]orchestrator.ScanProviderRequest, 0, len(specs))
	for _, s := range specs {
		req := orchestrator.ScanProviderRequest{
			Provider:      s.Provider,
			Subscriptions: s.Subscriptions,
			SelectionMode: s.SelectionMode,
		}

		// For NIOS provider: resolve the backup token to a temp file path.
		if s.Provider == "nios" && s.BackupToken != "" {
			if pathVal, ok := niosBackupTokens.LoadAndDelete(s.BackupToken); ok {
				req.BackupPath = pathVal.(string)
			}
			req.SelectedMembers = s.SelectedMembers
		}

		reqs = append(reqs, req)
	}
	return reqs
}

// writeJSON encodes v as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
