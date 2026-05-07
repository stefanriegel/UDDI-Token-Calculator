package server_test

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/server"
)

// postEfficientipUpload fires POST /api/v1/providers/efficientip/upload against
// router with the given filename and body bytes.
func postEfficientipUpload(t *testing.T, router http.Handler, filename string, content []byte) *httptest.ResponseRecorder {
	t.Helper()
	body, ct := buildMultipartBody(t, filename, content)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/efficientip/upload", body)
	req.Header.Set("Content-Type", ct)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// decodeEfficientIPUploadResponse decodes the JSON body of rec into EfficientIPUploadResponse.
func decodeEfficientIPUploadResponse(t *testing.T, rec *httptest.ResponseRecorder) server.EfficientIPUploadResponse {
	t.Helper()
	var resp server.EfficientIPUploadResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("json.Decode EfficientIPUploadResponse: %v", err)
	}
	return resp
}

// TestHandleUploadEfficientipBackup_GzFile verifies that a .gz file is accepted:
// status 200, valid=true, backupToken non-empty.
func TestHandleUploadEfficientipBackup_GzFile(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postEfficientipUpload(t, router, "backup.gz", []byte("any bytes"))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeEfficientIPUploadResponse(t, rec)
	if !resp.Valid {
		t.Fatalf("expected valid=true, got error: %s", resp.Error)
	}
	if resp.BackupToken == "" {
		t.Fatal("expected non-empty backupToken")
	}
}

// TestHandleUploadEfficientipBackup_UnsupportedType verifies that a .zip file
// returns 200 with valid=false and an error message mentioning ".gz".
func TestHandleUploadEfficientipBackup_UnsupportedType(t *testing.T) {
	router, _ := newUploadRouter(t)
	rec := postEfficientipUpload(t, router, "backup.zip", []byte("zip content"))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for unsupported type, got %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeEfficientIPUploadResponse(t, rec)
	if resp.Valid {
		t.Fatal("expected valid=false for unsupported file type")
	}
	if resp.Error == "" {
		t.Fatal("expected non-empty error message")
	}
	if !containsAny(resp.Error, "unsupported", ".gz") {
		t.Errorf("expected error to mention 'unsupported' or '.gz', got: %s", resp.Error)
	}
}

// TestHandleUploadEfficientipBackup_MissingFile verifies that a multipart body
// with no "file" field returns an error response.
func TestHandleUploadEfficientipBackup_MissingFile(t *testing.T) {
	router, _ := newUploadRouter(t)

	// Build multipart with wrong field name so no "file" part is present.
	buf := &bytes.Buffer{}
	mw := multipart.NewWriter(buf)
	fw, _ := mw.CreateFormFile("not_the_file_field", "backup.gz")
	fw.Write([]byte("content")) //nolint:errcheck
	mw.Close()                  //nolint:errcheck

	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/efficientip/upload", buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	// Handler returns 400 when the file field is missing.
	if rec.Code == http.StatusOK {
		resp := decodeEfficientIPUploadResponse(t, rec)
		if resp.Valid {
			t.Fatal("expected valid=false when file field is absent")
		}
		return
	}
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 or 200/valid=false for missing file field, got %d: %s", rec.Code, rec.Body.String())
	}
}

// containsAny returns true if s contains any of the given substrings.
func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if bytes.Contains([]byte(s), []byte(sub)) {
			return true
		}
	}
	return false
}
