package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infoblox/uddi-go-token-calculator/internal/session"
	"github.com/infoblox/uddi-go-token-calculator/server"
)

// stubValidator returns a fixed result without making any network calls.
// Used to inject into ValidateHandler for unit tests.
func stubOKValidator(subs []server.SubscriptionItem) func(context.Context, map[string]string) ([]server.SubscriptionItem, error) {
	return func(_ context.Context, _ map[string]string) ([]server.SubscriptionItem, error) {
		return subs, nil
	}
}

func stubErrValidator(msg string) func(context.Context, map[string]string) ([]server.SubscriptionItem, error) {
	return func(_ context.Context, _ map[string]string) ([]server.SubscriptionItem, error) {
		return nil, errors.New(msg)
	}
}

// newTestValidateHandler returns a ValidateHandler wired with a stub AWS validator
// that returns one subscription, so tests can exercise success paths without network calls.
func newTestValidateHandler(store *session.Store) *server.ValidateHandler {
	h := server.NewValidateHandler(store)
	stub := stubOKValidator([]server.SubscriptionItem{{ID: "test-acct", Name: "Test Account"}})
	h.AWSValidator = stub
	h.AzureValidator = stub
	h.GCPValidator = stub
	h.ADValidator = stub
	return h
}

// postValidate is a helper that sends a POST to /api/v1/providers/{provider}/validate
// through the full chi router so URL parameters are parsed correctly.
func postValidate(t *testing.T, store *session.Store, h *server.ValidateHandler, provider string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	router := server.NewRouter(noopStatic, store, nil)
	server.RegisterValidateHandler(router, h)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/"+provider+"/validate", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

// TestValidateDoesNotEchoCredentials: response body must not contain any credential value.
func TestValidateDoesNotEchoCredentials(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)

	secretValue := "super-secret-key-12345"
	body := map[string]interface{}{
		"authMethod": "access_key",
		"credentials": map[string]string{
			"accessKeyId":     "AKIAIOSFODNN7EXAMPLE",
			"secretAccessKey": secretValue,
		},
	}
	rec := postValidate(t, store, h, "aws", body)

	respBody := rec.Body.String()
	if strings.Contains(respBody, secretValue) {
		t.Errorf("response body contains credential value %q: %s", secretValue, respBody)
	}
	if strings.Contains(respBody, "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("response body contains accessKeyId: %s", respBody)
	}
}

// TestValidate_BadBody: malformed JSON → 400 Bad Request.
func TestValidate_BadBody(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)

	router := server.NewRouter(noopStatic, store, nil)
	server.RegisterValidateHandler(router, h)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/providers/aws/validate", strings.NewReader("{bad json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestValidate_UnknownProvider: unknown provider → 400, {valid:false, error:"unknown provider: unknown"}.
func TestValidate_UnknownProvider(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
	rec := postValidate(t, store, h, "unknown", map[string]interface{}{
		"authMethod":  "access_key",
		"credentials": map[string]string{},
	})

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp server.ValidateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Valid {
		t.Error("expected valid=false")
	}
	if !strings.Contains(resp.Error, "unknown provider: unknown") {
		t.Errorf("expected error to mention 'unknown provider: unknown', got %q", resp.Error)
	}
}

// TestValidate_ComingSoonAuthMethod: authMethod="sso" for AWS → 200, {valid:false, error:"Coming soon..."}.
func TestValidate_ComingSoonAuthMethod(t *testing.T) {
	store := session.NewStore()
	// Do NOT stub — use the real AWS validator so the coming-soon path fires.
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "aws", map[string]interface{}{
		"authMethod":  "sso",
		"credentials": map[string]string{},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp server.ValidateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Valid {
		t.Error("expected valid=false for coming-soon auth method")
	}
	if !strings.Contains(resp.Error, "Coming soon") {
		t.Errorf("expected 'Coming soon' in error, got %q", resp.Error)
	}
}

// TestValidate_SetsSessionCookie: successful validation sets httpOnly "ddi_session" cookie.
func TestValidate_SetsSessionCookie(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
	rec := postValidate(t, store, h, "aws", map[string]interface{}{
		"authMethod":  "access_key",
		"credentials": map[string]string{"accessKeyId": "A", "secretAccessKey": "B"},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Parse cookies from the response.
	resp := &http.Response{Header: rec.Header()}
	var ddiCookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "ddi_session" {
			ddiCookie = c
			break
		}
	}
	if ddiCookie == nil {
		t.Fatal("expected ddi_session cookie, not found")
	}
	if ddiCookie.Value == "" {
		t.Error("expected non-empty session cookie value")
	}
	if !ddiCookie.HttpOnly {
		t.Error("expected httpOnly cookie")
	}
}

// TestValidate_GCPStructuralOK: service_account_json non-empty → 200, valid:true, ≥1 subscription.
func TestValidate_GCPStructuralOK(t *testing.T) {
	store := session.NewStore()
	// Use the real GCP validator (stub logic based on structural check).
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "gcp", map[string]interface{}{
		"authMethod": "service_account",
		"credentials": map[string]string{
			"serviceAccountJson": `{"type":"service_account","project_id":"my-project"}`,
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp server.ValidateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Valid {
		t.Errorf("expected valid=true, got error: %q", resp.Error)
	}
	if len(resp.Subscriptions) == 0 {
		t.Error("expected at least one subscription entry")
	}
}

// TestValidate_GCPMissingField: empty service_account_json → 200, valid:false.
func TestValidate_GCPMissingField(t *testing.T) {
	store := session.NewStore()
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "gcp", map[string]interface{}{
		"authMethod": "service_account",
		"credentials": map[string]string{
			"serviceAccountJson": "",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp server.ValidateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Valid {
		t.Error("expected valid=false for empty service_account_json")
	}
	if resp.Error == "" {
		t.Error("expected error message")
	}
}

// TestValidate_ADStructuralOK: ntlm with host+username+password → 200, valid:true.
func TestValidate_ADStructuralOK(t *testing.T) {
	store := session.NewStore()
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "ad", map[string]interface{}{
		"authMethod": "ntlm",
		"credentials": map[string]string{
			"host":     "dc01.corp.example.com",
			"username": "admin",
			"password": "secret",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp server.ValidateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !resp.Valid {
		t.Errorf("expected valid=true, got error: %q", resp.Error)
	}
}

// TestValidate_ADMissingField: missing "host" in AD credentials → 200, valid:false.
func TestValidate_ADMissingField(t *testing.T) {
	store := session.NewStore()
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "ad", map[string]interface{}{
		"authMethod": "ntlm",
		"credentials": map[string]string{
			"username": "admin",
			"password": "secret",
			// "host" is missing
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp server.ValidateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.Valid {
		t.Error("expected valid=false for missing host")
	}
}
