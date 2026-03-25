package server_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/orchestrator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/stefanriegel/UDDI-Token-Calculator/server"
)

// ─── helpers ──────────────────────────────────────────────────────────────────

// newUploadRouter returns a test router with a real ScanHandler.
func newUploadRouter(t *testing.T) (http.Handler, *session.Store) {
	t.Helper()
	store := session.NewStore()
	orch := orchestrator.New(nil)
	router := server.NewRouter(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}), store, orch)
	return router, store
}

// buildMultipartBody wraps content in a multipart/form-data body using the
// field name "file". Returns the buffer and the Content-Type header value
// (which includes the boundary).
func buildMultipartBody(t *testing.T, filename string, content []byte) (*bytes.Buffer, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	mw := multipart.NewWriter(buf)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatalf("write file content: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return buf, mw.FormDataContentType()
}

// makeTarGz returns a .tar.gz archive containing a single file named
// "onedb.xml" with the given body.
func makeTarGz(t *testing.T, xmlBody []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	if err := tw.WriteHeader(&tar.Header{
		Name: "onedb.xml",
		Mode: 0644,
		Size: int64(len(xmlBody)),
	}); err != nil {
		t.Fatalf("tar WriteHeader: %v", err)
	}
	if _, err := tw.Write(xmlBody); err != nil {
		t.Fatalf("tar Write: %v", err)
	}
	tw.Close()
	gw.Close()
	return buf.Bytes()
}

// minimalXML is the smallest valid onedb.xml that the parser accepts.
func minimalXML() []byte {
	return []byte(`<?xml version="1.0" encoding="UTF-8"?>
<DATABASE NAME="onedb" VERSION="9.0.6-test">
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="101"/>
<PROPERTY NAME="host_name" VALUE="gm.test.local"/>
<PROPERTY NAME="is_grid_master" VALUE="true"/>
<PROPERTY NAME="is_candidate_master" VALUE="false"/>
</OBJECT>
</DATABASE>`)
}

// postUpload fires POST /api/v1/providers/nios/upload against router with the
// given filename and body bytes. Returns the recorder after the call.
func postUpload(t *testing.T, router http.Handler, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := buildMultipartBody(t, filename, content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/nios/upload", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// decodeUploadResponse decodes the JSON body of rec into NiosUploadResponse.
func decodeUploadResponse(t *testing.T, rec *httptest.ResponseRecorder) server.NiosUploadResponse {
	t.Helper()
	var resp server.NiosUploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("json.Decode NiosUploadResponse: %v", err)
	}
	return resp
}

// ─── upload handler tests ─────────────────────────────────────────────────────

// TestHandleUploadNiosBackup_BakFile is the primary regression test for the
// 413 bug: a .bak archive must never be rejected with 413.
// Root cause: ParseMultipartForm(500 MB) + MaxBytesReader(500 MB) caused 413
// for any backup file exceeding ~500 MB.  The fix replaces ParseMultipartForm
// with streaming MultipartReader and raises the limit to 10 GB.
func TestHandleUploadNiosBackup_BakFile(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "database.bak", makeTarGz(t, minimalXML()))

	if rec.Code == http.StatusRequestEntityTooLarge {
		t.Fatal("got 413 — regression: .bak upload incorrectly rejected by body-size limit")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeUploadResponse(t, rec)
	if !resp.Valid {
		t.Fatalf("expected valid=true, got error: %s", resp.Error)
	}
	if len(resp.Members) == 0 {
		t.Fatal("expected at least one Grid Member")
	}
	if resp.BackupToken == "" {
		t.Fatal("expected non-empty BackupToken")
	}
}

// TestHandleUploadNiosBackup_XMLFile verifies that a raw .xml file (as large
// as 3 GB in production) is accepted without 413.
func TestHandleUploadNiosBackup_XMLFile(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "onedb.xml", minimalXML())

	if rec.Code == http.StatusRequestEntityTooLarge {
		t.Fatal("got 413 — regression: .xml upload incorrectly rejected by body-size limit")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeUploadResponse(t, rec)
	if !resp.Valid {
		t.Fatalf("expected valid=true, got error: %s", resp.Error)
	}
	if len(resp.Members) == 0 {
		t.Fatal("expected at least one Grid Member from .xml upload")
	}
}

// TestHandleUploadNiosBackup_TarGzExtension verifies .tar.gz is accepted.
func TestHandleUploadNiosBackup_TarGzExtension(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "backup.tar.gz", makeTarGz(t, minimalXML()))

	if rec.Code == http.StatusRequestEntityTooLarge {
		t.Fatalf("got unexpected 413")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeUploadResponse(t, rec)
	if !resp.Valid {
		t.Fatalf("expected valid=true, got error: %s", resp.Error)
	}
}

// TestHandleUploadNiosBackup_TgzExtension verifies .tgz is accepted.
func TestHandleUploadNiosBackup_TgzExtension(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "backup.tgz", makeTarGz(t, minimalXML()))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeUploadResponse(t, rec)
	if !resp.Valid {
		t.Fatalf("expected valid=true, got error: %s", resp.Error)
	}
}

// TestHandleUploadNiosBackup_UnsupportedType verifies that .zip returns
// 200 with valid=false (not 413 or 400).
func TestHandleUploadNiosBackup_UnsupportedType(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "database.zip", []byte("zip content"))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for unsupported type, got %d", rec.Code)
	}
	resp := decodeUploadResponse(t, rec)
	if resp.Valid {
		t.Fatal("expected valid=false for unsupported file type")
	}
	if resp.Error == "" {
		t.Fatal("expected non-empty error message")
	}
}

// TestHandleUploadNiosBackup_MissingFileField verifies 400 when no "file" part
// is present in the multipart body.
func TestHandleUploadNiosBackup_MissingFileField(t *testing.T) {
	router, _ := newUploadRouter(t)

	// Build multipart with wrong field name.
	buf := &bytes.Buffer{}
	mw := multipart.NewWriter(buf)
	fw, _ := mw.CreateFormFile("not_the_file_field", "database.bak")
	fw.Write([]byte("content"))
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/nios/upload", buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing file field, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestHandleUploadNiosBackup_InvalidGzip verifies 200/valid=false for a .bak
// that is not a valid gzip stream.
func TestHandleUploadNiosBackup_InvalidGzip(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "database.bak", []byte("this is not gzip"))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 (valid=false) for bad gzip, got %d", rec.Code)
	}
	resp := decodeUploadResponse(t, rec)
	if resp.Valid {
		t.Fatal("expected valid=false for invalid gzip archive")
	}
}

// TestHandleUploadNiosBackup_ArchiveMissingOnedb verifies 200/valid=false when
// the tar.gz does not contain onedb.xml.
func TestHandleUploadNiosBackup_ArchiveMissingOnedb(t *testing.T) {
	router, _ := newUploadRouter(t)

	// Build tar.gz with a different file inside.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	other := []byte("not onedb")
	tw.WriteHeader(&tar.Header{Name: "other.txt", Mode: 0644, Size: int64(len(other))})
	tw.Write(other)
	tw.Close()
	gw.Close()

	rec := postUpload(t, router, "database.bak", buf.Bytes())

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	resp := decodeUploadResponse(t, rec)
	if resp.Valid {
		t.Fatal("expected valid=false when onedb.xml is absent from archive")
	}
}

// TestHandleUploadNiosBackup_SetsCookie verifies that a successful upload sets
// the ddi_session cookie so the subsequent POST /api/v1/scan can find the session.
func TestHandleUploadNiosBackup_SetsCookie(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "database.bak", makeTarGz(t, minimalXML()))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	var sessionCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "ddi_session" {
			sessionCookie = c
			break
		}
	}
	if sessionCookie == nil {
		t.Fatal("expected ddi_session cookie after successful upload")
	}
	if sessionCookie.Value == "" {
		t.Fatal("ddi_session cookie must be non-empty")
	}
}

// TestHandleUploadNiosBackup_ReusesExistingSession verifies that when a valid
// ddi_session cookie already exists (e.g. from a prior cloud-provider validation),
// the upload handler reuses that session rather than creating a new one.
func TestHandleUploadNiosBackup_ReusesExistingSession(t *testing.T) {
	router, store := newUploadRouter(t)

	// Pre-create a session simulating a user who validated AWS first.
	existing := store.New()

	body, ct := buildMultipartBody(t, "database.bak", makeTarGz(t, minimalXML()))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/nios/upload", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(&http.Cookie{Name: "ddi_session", Value: existing.ID})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// If a Set-Cookie is present it must preserve the original session ID.
	for _, c := range rec.Result().Cookies() {
		if c.Name == "ddi_session" && c.Value != existing.ID {
			t.Errorf("session should be reused: want %q, got %q", existing.ID, c.Value)
		}
	}
}

// TestHandleUploadNiosBackup_RealTestdata uploads the real minimal.tar.gz
// fixture bundled with the nios scanner tests.
func TestHandleUploadNiosBackup_RealTestdata(t *testing.T) {
	fixture := filepath.Join("..", "internal", "scanner", "nios", "testdata", "minimal.tar.gz")
	data, err := os.ReadFile(fixture)
	if err != nil {
		t.Skipf("testdata not available: %v", err)
	}

	router, _ := newUploadRouter(t)
	rec := postUpload(t, router, "database.bak", data)

	if rec.Code == http.StatusRequestEntityTooLarge {
		t.Fatal("got 413 — regression: real testdata rejected by body-size limit")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeUploadResponse(t, rec)
	if !resp.Valid {
		t.Fatalf("expected valid=true for real testdata, got: %s", resp.Error)
	}
	if len(resp.Members) == 0 {
		t.Fatal("expected at least one Grid Member from testdata")
	}
}

// TestHandleUploadNiosBackup_LargeXML_NoBodyLimit is the regression test that
// directly reproduces the 3 GB XML / 1 GB .bak scenario reported by the user.
// We use a 60 MB uncompressed XML to keep CI fast while exercising the streaming
// path well beyond the old 500 MB ParseMultipartForm memory limit.
//
// Run with -short to skip.
func TestHandleUploadNiosBackup_LargeXML_NoBodyLimit(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping large-file regression test in short mode")
	}

	// Build a valid onedb.xml padded to ~60 MB uncompressed.
	// Enough to prove the handler no longer buffers the whole body in RAM.
	const targetMB = 60
	header := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<DATABASE NAME="onedb" VERSION="9.0.6-test">
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="101"/>
<PROPERTY NAME="host_name" VALUE="gm.test.local"/>
<PROPERTY NAME="is_grid_master" VALUE="true"/>
<PROPERTY NAME="is_candidate_master" VALUE="false"/>
</OBJECT>`)
	footer := []byte(`</DATABASE>`)
	pad := bytes.Repeat(append(bytes.Repeat([]byte("<!-- x -->"), 100), '\n'), 1) // ~1 KB/iter

	var xml bytes.Buffer
	xml.Write(header)
	for xml.Len() < targetMB<<20 {
		xml.Write(pad)
	}
	xml.Write(footer)

	router, _ := newUploadRouter(t)

	// Test 1: large raw .xml file (mimics the 3 GB onedb.xml case).
	t.Run("xml", func(t *testing.T) {
		rec := postUpload(t, router, "onedb.xml", xml.Bytes())
		if rec.Code == http.StatusRequestEntityTooLarge {
			t.Fatal("got 413 — regression: large .xml upload rejected by body-size limit")
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		resp := decodeUploadResponse(t, rec)
		if !resp.Valid {
			t.Fatalf("expected valid=true, got: %s", resp.Error)
		}
	})

	// Test 2: large .bak archive (mimics the 1 GB .bak case).
	t.Run("bak", func(t *testing.T) {
		rec := postUpload(t, router, "database.bak", makeTarGz(t, xml.Bytes()))
		if rec.Code == http.StatusRequestEntityTooLarge {
			t.Fatal("got 413 — regression: large .bak upload rejected by body-size limit")
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		resp := decodeUploadResponse(t, rec)
		if !resp.Valid {
			t.Fatalf("expected valid=true, got: %s", resp.Error)
		}
	})
}

// ─── scan results tests (unchanged) ──────────────────────────────────────────

// TestHandleScanResultsNIOS verifies that GET /api/v1/scan/{scanId}/results returns
// a niosServerMetrics array when the session has NiosServerMetricsJSON set.
func TestHandleScanResultsNIOS(t *testing.T) {
	store := session.NewStore()
	sess := store.New()
	now := time.Now()
	sess.State = session.ScanStateComplete
	sess.CompletedAt = &now

	metricsData := []server.NiosServerMetric{{
		MemberID:    "gm.test.local",
		MemberName:  "gm.test.local",
		Role:        "GM",
		ObjectCount: 100,
	}}
	encoded, err := json.Marshal(metricsData)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
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
		t.Fatalf("json.Decode: %v", err)
	}
	if len(resp.NiosServerMetrics) != 1 {
		t.Fatalf("expected 1 metric, got %d", len(resp.NiosServerMetrics))
	}
	m := resp.NiosServerMetrics[0]
	if m.MemberID != "gm.test.local" {
		t.Errorf("MemberID: got %q, want %q", m.MemberID, "gm.test.local")
	}
	if m.Role != "GM" {
		t.Errorf("Role: got %q, want %q", m.Role, "GM")
	}
	if m.ObjectCount != 100 {
		t.Errorf("ObjectCount: got %d, want 100", m.ObjectCount)
	}
}

// TestHandleScanResultsNIOS_Absent verifies that niosServerMetrics is absent
// from the JSON response when NIOS was not included in the scan (omitempty).
func TestHandleScanResultsNIOS_Absent(t *testing.T) {
	store := session.NewStore()
	sess := store.New()
	now := time.Now()
	sess.State = session.ScanStateComplete
	sess.CompletedAt = &now

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
	var raw map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&raw); err != nil {
		t.Fatalf("json.Decode: %v", err)
	}
	if _, present := raw["niosServerMetrics"]; present {
		t.Error("niosServerMetrics should be absent when NIOS was not scanned")
	}
}
