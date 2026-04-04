package server

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	cryptoRand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/orchestrator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/nios"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
)

// niosBackupEntry holds a temp file path and an expiry time for automatic cleanup.
type niosBackupEntry struct {
	path    string
	expires time.Time
}

// niosBackupTokens maps opaque upload tokens to backup entries.
// Entries are removed when HandleStartScan consumes them (LoadAndDelete) or when
// the background cleanup goroutine purges entries that have passed their TTL.
var niosBackupTokens sync.Map

// niosTokenTTL is how long an unused backup token/file is kept before automatic cleanup.
// A user who uploads but never clicks Scan within this window will have their temp file removed.
const niosTokenTTL = 2 * time.Hour

// efficientipBackupTokens maps opaque upload tokens to temp file paths for EfficientIP backups.
// Entries are removed when HandleStartScan consumes them via LoadAndDelete.
var efficientipBackupTokens sync.Map

func init() {
	// Background goroutine: periodically remove temp files whose tokens have expired.
	go func() {
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			now := time.Now()
			niosBackupTokens.Range(func(key, value any) bool {
				entry, ok := value.(niosBackupEntry)
				if !ok || now.After(entry.expires) {
					os.Remove(entry.path) //nolint:errcheck
					niosBackupTokens.Delete(key)
				}
				return true
			})
		}
	}()
}

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

		// Build per-provider progress from session and compute overall average.
		provProgress := sess.GetProviderProgress()
		if len(provProgress) > 0 {
			totalProgress := 0
			for name, info := range provProgress {
				resp.Providers = append(resp.Providers, ProviderScanStatus{
					Provider:   name,
					Status:     info.Status,
					Progress:   info.Progress,
					ItemsFound: info.ItemsFound,
				})
				totalProgress += info.Progress
			}
			resp.Progress = totalProgress / len(provProgress)
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// niosMaxUploadBytes is the hard cap on the total multipart request body for NIOS
// backup uploads. NIOS Grid databases from production environments can easily
// exceed several gigabytes, so we set a generous 10 GB limit to prevent 413
// errors for large but legitimate backups.
const niosMaxUploadBytes = 10 << 30 // 10 GB

// HandleUploadNiosBackup handles POST /api/v1/providers/nios/upload.
//
// Accepts a multipart form upload with a "file" field containing a .tar.gz, .tgz,
// .bak, or .xml NIOS backup file (max 10 GB). Uses streaming multipart parsing
// (r.MultipartReader) to avoid buffering the entire request body in memory.
//
// Upload flow:
//  1. Stream the multipart body; extract onedb.xml to a temp file in one pass
//     (for archives: decompress gzip+tar on the fly; for raw XML: copy directly).
//  2. After the temp file is fully written, call nios.StreamMembers to extract
//     Grid Member hostnames and roles using the fast byte-level parser.
//  3. Register the temp file path under an opaque token (with a 2-hour TTL) and
//     return it to the frontend. The token is consumed by HandleStartScan, which
//     passes it to the NIOS scanner as backup_path.
//
// The two-step approach (write-then-parse) avoids the TeeReader+encoding/xml
// combination used previously, which was 10-50x slower than the byte-level parser
// and forced a single-pass constraint that complicated error handling.
func (h *ScanHandler) HandleUploadNiosBackup(w http.ResponseWriter, r *http.Request) {
	// Streaming multipart parse — no memory buffering of the file.
	// We do NOT use http.MaxBytesReader here because it wraps r.Body with a
	// non-standard type that causes Go's HTTP server to set Connection: close
	// on every response, breaking Chrome's persistent-connection keep-alive.
	// Instead we enforce the size limit during the copy step with io.LimitedReader.
	mr, err := r.MultipartReader()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, NiosUploadResponse{Valid: false, Error: "failed to parse multipart request: " + err.Error(), Members: []NiosGridMember{}})
		return
	}

	// Find the "file" part.
	var filePart io.Reader
	var filename string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			if strings.Contains(err.Error(), "request body too large") || strings.Contains(err.Error(), "http: request body too large") {
				writeJSON(w, http.StatusRequestEntityTooLarge, NiosUploadResponse{Valid: false, Error: fmt.Sprintf("file too large (max %d GB)", niosMaxUploadBytes>>30), Members: []NiosGridMember{}})
				return
			}
			writeJSON(w, http.StatusBadRequest, NiosUploadResponse{Valid: false, Error: "error reading multipart stream: " + err.Error(), Members: []NiosGridMember{}})
			return
		}
		if part.FormName() == "file" {
			filePart = part
			filename = part.FileName()
			break
		}
		io.Copy(io.Discard, part) //nolint:errcheck
	}

	if filePart == nil {
		writeJSON(w, http.StatusBadRequest, NiosUploadResponse{Valid: false, Error: "missing file field", Members: []NiosGridMember{}})
		return
	}

	name := strings.ToLower(filename)
	isXML := strings.HasSuffix(name, ".xml")
	isArchive := strings.HasSuffix(name, ".tar.gz") || strings.HasSuffix(name, ".tgz") || strings.HasSuffix(name, ".bak")
	if !isXML && !isArchive {
		writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: "unsupported file type: must be .tar.gz, .tgz, .bak, or .xml", Members: []NiosGridMember{}})
		return
	}

	// Step 1: stream the upload to a temp file.
	// For archives: decompress gzip+tar on-the-fly and extract only onedb.xml.
	// For raw XML: copy directly.
	tmp, err := os.CreateTemp("", "nios-onedb-*.xml")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, NiosUploadResponse{Valid: false, Error: "failed to create temp file: " + err.Error(), Members: []NiosGridMember{}})
		return
	}
	tmpPath := tmp.Name()

	var writeErr error
	if isXML {
		bw := bufio.NewWriterSize(tmp, 256<<10)
		lr := &io.LimitedReader{R: filePart, N: niosMaxUploadBytes}
		_, writeErr = io.Copy(bw, lr)
		if writeErr == nil && lr.N == 0 {
			writeErr = fmt.Errorf("file too large (max %d GB)", niosMaxUploadBytes>>30)
		}
		if writeErr == nil {
			writeErr = bw.Flush()
		}
	} else {
		gz, gzErr := gzip.NewReader(filePart)
		if gzErr != nil {
			tmp.Close()
			os.Remove(tmpPath)
			writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: "not a valid gzip archive: " + gzErr.Error(), Members: []NiosGridMember{}})
			return
		}
		tr := tar.NewReader(gz)
		foundXML := false
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				gz.Close()
				tmp.Close()
				os.Remove(tmpPath)
				writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: "error reading archive: " + err.Error(), Members: []NiosGridMember{}})
				return
			}
			if filepath.Base(hdr.Name) != "onedb.xml" {
				continue
			}
			foundXML = true
			bw := bufio.NewWriterSize(tmp, 256<<10)
			lr := &io.LimitedReader{R: tr, N: niosMaxUploadBytes}
			if _, err := io.Copy(bw, lr); err != nil {
				writeErr = err
			} else if lr.N == 0 {
				writeErr = fmt.Errorf("file too large (max %d GB)", niosMaxUploadBytes>>30)
			} else {
				writeErr = bw.Flush()
			}
			gz.Close()
			break
		}
		if !foundXML {
			tmp.Close()
			os.Remove(tmpPath)
			// Drain remaining request body so Go can reuse the connection (avoid Connection: close).
			io.Copy(io.Discard, filePart) //nolint:errcheck
			writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: "no onedb.xml found in backup", Members: []NiosGridMember{}})
			return
		}
	}
	tmp.Close()

	// Drain any unread bytes from the multipart body (remaining tar entries, trailing
	// multipart boundary) so Go's HTTP server sees the request body fully consumed
	// and can keep the connection alive (avoids Connection: close on the response).
	io.Copy(io.Discard, filePart) //nolint:errcheck
	for {
		part, err := mr.NextPart()
		if err != nil {
			break
		}
		io.Copy(io.Discard, part) //nolint:errcheck
	}

	if writeErr != nil {
		os.Remove(tmpPath)
		writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: "error writing temp file: " + writeErr.Error(), Members: []NiosGridMember{}})
		return
	}

	// Step 2: extract Grid Members using the fast byte-level parser.
	// This is 10-50x faster than encoding/xml and avoids a second decompression pass.
	gridMembers, parseErr := nios.StreamMembers(tmpPath)
	if parseErr != nil {
		os.Remove(tmpPath)
		writeJSON(w, http.StatusOK, NiosUploadResponse{Valid: false, Error: parseErr.Error(), Members: []NiosGridMember{}})
		return
	}

	members := make([]NiosGridMember, 0, len(gridMembers))
	for _, m := range gridMembers {
		members = append(members, NiosGridMember{Hostname: m.Hostname, Role: m.Role})
	}

	// Register the temp file under an opaque token with a 2-hour TTL.
	// The background cleanup goroutine removes files whose tokens expire unused.
	token := fmt.Sprintf("%d", time.Now().UnixNano())
	niosBackupTokens.Store(token, niosBackupEntry{
		path:    tmpPath,
		expires: time.Now().Add(niosTokenTTL),
	})

	// Reuse existing session if one exists (multi-provider scenario), otherwise
	// create a new one. This mirrors the same logic in validate.go HandleValidate
	// so that NIOS + cloud provider credentials coexist in one session.
	var sess *session.Session
	if cookie, err := r.Cookie("ddi_session"); err == nil {
		if existing, ok := h.store.Get(cookie.Value); ok && existing.State == session.ScanStateCreated {
			sess = existing
		}
	}
	if sess == nil {
		sess = h.store.New()
		http.SetCookie(w, &http.Cookie{
			Name:     "ddi_session",
			Value:    sess.ID,
			HttpOnly: true,
			Secure:   false,
			SameSite: http.SameSiteStrictMode,
			Path:     "/",
			MaxAge:   3600,
		})
	}

	writeJSON(w, http.StatusOK, NiosUploadResponse{
		Valid:       true,
		Members:     members,
		BackupToken: token,
	})
}

// parseOneDBXML and objectToMember were removed — member extraction is now handled
// by nios.StreamMembers (fast byte-level parser, 10-50x faster than encoding/xml).

// HandleUploadEfficientipBackup handles POST /api/v1/providers/efficientip/upload.
//
// Accepts a multipart form upload with a "file" field containing a .gz SOLIDserver
// backup archive (max 10 GB). Writes the file to a temp path and returns an opaque
// BackupToken the frontend must pass back in the scan-start request.
func (h *ScanHandler) HandleUploadEfficientipBackup(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, niosMaxUploadBytes)

	mr, err := r.MultipartReader()
	if err != nil {
		writeJSON(w, http.StatusBadRequest, EfficientIPUploadResponse{Valid: false, Error: "failed to parse multipart request: " + err.Error()})
		return
	}

	var filePart io.Reader
	var filename string
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			if strings.Contains(err.Error(), "request body too large") || strings.Contains(err.Error(), "http: request body too large") {
				writeJSON(w, http.StatusRequestEntityTooLarge, EfficientIPUploadResponse{Valid: false, Error: fmt.Sprintf("file too large (max %d GB)", niosMaxUploadBytes>>30)})
				return
			}
			writeJSON(w, http.StatusBadRequest, EfficientIPUploadResponse{Valid: false, Error: "error reading multipart stream: " + err.Error()})
			return
		}
		if part.FormName() == "file" {
			filePart = part
			filename = part.FileName()
			break
		}
		io.Copy(io.Discard, part) //nolint:errcheck
	}

	if filePart == nil {
		writeJSON(w, http.StatusBadRequest, EfficientIPUploadResponse{Valid: false, Error: "missing file field"})
		return
	}

	name := strings.ToLower(filename)
	if !strings.HasSuffix(name, ".gz") {
		writeJSON(w, http.StatusOK, EfficientIPUploadResponse{Valid: false, Error: "unsupported file type: must be .gz"})
		return
	}

	tmp, err := os.CreateTemp("", "efficientip-backup-*.gz")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, EfficientIPUploadResponse{Valid: false, Error: "failed to create temp file: " + err.Error()})
		return
	}

	if _, err := io.Copy(tmp, filePart); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusInternalServerError, EfficientIPUploadResponse{Valid: false, Error: "failed to write temp file: " + err.Error()})
		return
	}
	tmp.Close()

	tokenBytes := make([]byte, 16)
	if _, err := cryptoRand.Read(tokenBytes); err != nil {
		os.Remove(tmp.Name())
		writeJSON(w, http.StatusInternalServerError, EfficientIPUploadResponse{Valid: false, Error: "failed to generate token: " + err.Error()})
		return
	}
	token := fmt.Sprintf("%x", tokenBytes)
	efficientipBackupTokens.Store(token, tmp.Name())

	writeJSON(w, http.StatusOK, EfficientIPUploadResponse{
		Valid:       true,
		BackupToken: token,
	})
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

	// Aggregate rows sharing the same (provider, source, item) to avoid
	// duplicate display rows (e.g., 15 ec2_ip rows across 15 AWS regions).
	// This is display-only — calculator.Calculate already sums globally.
	findings = aggregateFindings(findings)

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

	// Decode NiosGridFeaturesJSON if a NIOS scan was performed.
	var niosGridFeatures *NiosGridFeatures
	if len(sess.NiosGridFeaturesJSON) > 0 {
		niosGridFeatures = &NiosGridFeatures{}
		if err := json.Unmarshal(sess.NiosGridFeaturesJSON, niosGridFeatures); err != nil {
			fmt.Fprintf(os.Stderr, "server: failed to decode NiosGridFeaturesJSON: %v\n", err)
			niosGridFeatures = nil
		}
	}

	// Decode NiosGridLicensesJSON if a NIOS scan was performed.
	var niosGridLicenses *NiosGridLicenses
	if len(sess.NiosGridLicensesJSON) > 0 {
		niosGridLicenses = &NiosGridLicenses{}
		if err := json.Unmarshal(sess.NiosGridLicensesJSON, niosGridLicenses); err != nil {
			fmt.Fprintf(os.Stderr, "server: failed to decode NiosGridLicensesJSON: %v\n", err)
			niosGridLicenses = nil
		}
	}

	// Decode ADServerMetricsJSON if an AD scan was performed.
	var adMetrics []ADServerMetric
	if len(sess.ADServerMetricsJSON) > 0 {
		if err := json.Unmarshal(sess.ADServerMetricsJSON, &adMetrics); err != nil {
			fmt.Fprintf(os.Stderr, "server: failed to decode ADServerMetricsJSON: %v\n", err)
			adMetrics = nil
		}
	}

	// Decode NiosMigrationFlagsJSON if a NIOS backup scan found migration flags.
	var niosMigrationFlags *NiosMigrationFlags
	if len(sess.NiosMigrationFlagsJSON) > 0 {
		niosMigrationFlags = &NiosMigrationFlags{}
		if err := json.Unmarshal(sess.NiosMigrationFlagsJSON, niosMigrationFlags); err != nil {
			fmt.Fprintf(os.Stderr, "server: failed to decode NiosMigrationFlagsJSON: %v\n", err)
			niosMigrationFlags = nil
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
		NiosServerMetrics:     niosMetrics,      // nil → omitted by omitempty
		NiosGridFeatures:      niosGridFeatures,  // nil → omitted by omitempty
		NiosGridLicenses:      niosGridLicenses,  // nil → omitted by omitempty
		ADServerMetrics:       adMetrics,         // nil → omitted by omitempty
		NiosMigrationFlags:    niosMigrationFlags, // nil → omitted by omitempty
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
			Provider:       s.Provider,
			Subscriptions:  s.Subscriptions,
			SelectionMode:  s.SelectionMode,
			MaxWorkers:     s.MaxWorkers,
			RequestTimeout: s.RequestTimeout,
			CheckpointPath: s.CheckpointPath,
		}

		// For AD provider: if the frontend sent per-forest subscriptions, apply
		// forest 0 subscriptions to the primary request. Additional forests are
		// expanded by the orchestrator using sess.ADForests — but we need to
		// carry their per-forest subscriptions through via ADForestSubscriptions.
		// For the primary request, use ADForestSubscriptions[0] if present.
		if s.Provider == "ad" && len(s.ADForestSubscriptions) > 0 {
			for _, fs := range s.ADForestSubscriptions {
				if fs.ForestIndex == 0 {
					req.Subscriptions = fs.Subscriptions
				}
			}
		}

		// For NIOS provider: dispatch based on Mode field.
		if s.Provider == "nios" {
			if s.Mode == "wapi" {
				req.Mode = "wapi"
				req.SelectedMembers = s.SelectedMembers
			} else {
				// Backup mode (default): resolve the backup token to a temp file path.
				if s.BackupToken != "" {
					if entryVal, ok := niosBackupTokens.LoadAndDelete(s.BackupToken); ok {
						if entry, ok := entryVal.(niosBackupEntry); ok {
							req.BackupPath = entry.path
						}
					}
				}
				req.SelectedMembers = s.SelectedMembers
			}
		}

		// For EfficientIP provider: backup mode requires resolving the BackupToken.
		if s.Provider == "efficientip" && s.Mode == "backup" {
			if s.BackupToken != "" {
				if pathVal, ok := efficientipBackupTokens.LoadAndDelete(s.BackupToken); ok {
					req.BackupPath = pathVal.(string)
				}
			}
		}

		reqs = append(reqs, req)
	}
	return reqs
}

// aggregateFindings merges FindingRowResponse rows that share the same
// (provider, source, item) key. For merged rows: counts are summed,
// category and tokensPerUnit are kept from the first row (always identical
// for the same item), managementTokens is recalculated as ceil(sum/tokensPerUnit),
// and region is cleared (meaningless after aggregation).
func aggregateFindings(rows []FindingRowResponse) []FindingRowResponse {
	if len(rows) == 0 {
		return rows
	}

	type key struct{ provider, source, item string }
	type agg struct {
		row   FindingRowResponse
		order int // preserve insertion order
	}

	merged := make(map[key]*agg, len(rows))
	var order int
	for _, r := range rows {
		k := key{r.Provider, r.Source, r.Item}
		if existing, ok := merged[k]; ok {
			existing.row.Count += r.Count
		} else {
			cp := r
			cp.Region = "" // drop region — meaningless after aggregation
			merged[k] = &agg{row: cp, order: order}
			order++
		}
	}

	// Recalculate managementTokens and collect results in insertion order.
	result := make([]FindingRowResponse, 0, len(merged))
	for _, a := range merged {
		if a.row.TokensPerUnit > 0 {
			a.row.ManagementTokens = int(math.Ceil(float64(a.row.Count) / float64(a.row.TokensPerUnit)))
		}
		result = append(result, a.row)
	}

	// Sort by insertion order (map iteration is unordered).
	sortByOrder := make(map[key]int, len(merged))
	for k, a := range merged {
		sortByOrder[k] = a.order
	}
	for i := 0; i < len(result)-1; i++ {
		for j := i + 1; j < len(result); j++ {
			ki := key{result[i].Provider, result[i].Source, result[i].Item}
			kj := key{result[j].Provider, result[j].Source, result[j].Item}
			if sortByOrder[ki] > sortByOrder[kj] {
				result[i], result[j] = result[j], result[i]
			}
		}
	}

	return result
}

// writeJSON encodes v as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
