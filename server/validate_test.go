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

// TestValidate_SSOWithEmptyCredentials: authMethod="sso" for AWS with missing fields
// → 200, {valid:false, error:"ssoStartUrl and ssoRegion are required..."}.
// SSO is a real path (not "coming soon") — supplying empty credentials returns
// a descriptive field-validation error.
func TestValidate_SSOWithEmptyCredentials(t *testing.T) {
	store := session.NewStore()
	// Do NOT stub — use the real AWS validator so the SSO path fires.
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
		t.Error("expected valid=false for SSO with missing credentials")
	}
	if !strings.Contains(resp.Error, "ssoStartUrl") && !strings.Contains(resp.Error, "ssoRegion") {
		t.Errorf("expected error about missing SSO fields, got %q", resp.Error)
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
// Uses a stub validator to avoid a real WinRM network call.
func TestValidate_ADStructuralOK(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
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

// TestValidate_ADMissingPassword: missing "password" in AD credentials → 200, valid:false,
// error mentions "required". Uses the real realADValidator so the structural guard fires
// before any network attempt is made.
func TestValidate_ADMissingPassword(t *testing.T) {
	store := session.NewStore()
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "ad", map[string]interface{}{
		"authMethod": "ntlm",
		"credentials": map[string]string{
			"server":   "dc01.corp.example.com",
			"username": "admin",
			// "password" is missing
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
		t.Error("expected valid=false for missing password")
	}
	if !strings.Contains(resp.Error, "required") {
		t.Errorf("expected error to mention 'required', got %q", resp.Error)
	}
}

// ---------------------------------------------------------------------------
// storeCredentials field-key consistency tests
//
// These verify that storeCredentials correctly maps frontend credential field
// keys to session struct fields, including fallback handling for keys that
// differ between frontend and backend.
//
// Audit of frontend field keys vs backend storeCredentials reads:
//
//   Frontend Key          | storeCredentials Key   | Match
//   ----------------------|------------------------|------
//   accessKeyId           | accessKeyId            | exact
//   secretAccessKey       | secretAccessKey         | exact
//   region                | region                 | exact
//   profile               | profileName + profile  | fallback (fixed)
//   roleArn               | roleArn                | exact
//   ssoStartUrl           | ssoStartUrl            | exact
//   ssoRegion             | ssoRegion              | exact
//   tenantId              | tenantId               | exact
//   clientId              | clientId               | exact
//   clientSecret          | clientSecret           | exact
//   serviceAccountJson    | serviceAccountJson     | exact
//   server                | servers + server       | fallback (fixed)
//   username              | username               | exact
//   password              | password               | exact
// ---------------------------------------------------------------------------

// TestStoreCredentials_ADServerSingular: frontend sends "server" (singular) —
// storeCredentials must populate sess.AD.Hosts via fallback.
func TestStoreCredentials_ADServerSingular(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)

	rec := postValidate(t, store, h, "ad", map[string]interface{}{
		"authMethod": "ntlm",
		"credentials": map[string]string{
			"server":   "dc01.corp.example.com",
			"username": "admin",
			"password": "secret",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	// Extract session ID from cookie and verify AD.Hosts was populated.
	resp := &http.Response{Header: rec.Header()}
	var sessionID string
	for _, c := range resp.Cookies() {
		if c.Name == "ddi_session" {
			sessionID = c.Value
			break
		}
	}
	if sessionID == "" {
		t.Fatal("expected ddi_session cookie")
	}

	sess, ok := store.Get(sessionID)
	if !ok {
		t.Fatal("session not found in store")
	}
	if sess.AD == nil {
		t.Fatal("expected sess.AD to be set")
	}
	if len(sess.AD.Hosts) == 0 {
		t.Fatal("expected sess.AD.Hosts to contain the server address, got empty slice")
	}
	if sess.AD.Hosts[0] != "dc01.corp.example.com" {
		t.Errorf("expected Hosts[0]=%q, got %q", "dc01.corp.example.com", sess.AD.Hosts[0])
	}
}

// TestStoreCredentials_AWSProfileKey: frontend sends "profile" (not "profileName") —
// storeCredentials must populate sess.AWS.ProfileName via fallback.
func TestStoreCredentials_AWSProfileKey(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)

	rec := postValidate(t, store, h, "aws", map[string]interface{}{
		"authMethod": "profile",
		"credentials": map[string]string{
			"profile": "my-named-profile",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := &http.Response{Header: rec.Header()}
	var sessionID string
	for _, c := range resp.Cookies() {
		if c.Name == "ddi_session" {
			sessionID = c.Value
			break
		}
	}
	if sessionID == "" {
		t.Fatal("expected ddi_session cookie")
	}

	sess, ok := store.Get(sessionID)
	if !ok {
		t.Fatal("session not found in store")
	}
	if sess.AWS == nil {
		t.Fatal("expected sess.AWS to be set")
	}
	if sess.AWS.ProfileName != "my-named-profile" {
		t.Errorf("expected ProfileName=%q, got %q", "my-named-profile", sess.AWS.ProfileName)
	}
}

// TestValidate_MultiProviderSessionReuse: validating two providers sequentially
// reuses the same session, so both providers' credentials are available for scanning.
func TestValidate_MultiProviderSessionReuse(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
	router := server.NewRouter(noopStatic, store, nil)
	server.RegisterValidateHandler(router, h)

	// Step 1: Validate AWS — creates a new session and sets ddi_session cookie.
	awsBody, _ := json.Marshal(map[string]interface{}{
		"authMethod": "access-key",
		"credentials": map[string]string{
			"accessKeyId":     "AKIA-TEST",
			"secretAccessKey": "secret",
			"region":          "us-east-1",
		},
	})
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/providers/aws/validate", bytes.NewReader(awsBody))
	req1.Header.Set("Content-Type", "application/json")
	rec1 := httptest.NewRecorder()
	router.ServeHTTP(rec1, req1)

	if rec1.Code != http.StatusOK {
		t.Fatalf("AWS validate: expected 200, got %d: %s", rec1.Code, rec1.Body.String())
	}

	// Extract ddi_session cookie from first response.
	var sessionCookie *http.Cookie
	for _, c := range (&http.Response{Header: rec1.Header()}).Cookies() {
		if c.Name == "ddi_session" {
			sessionCookie = c
			break
		}
	}
	if sessionCookie == nil {
		t.Fatal("expected ddi_session cookie after AWS validate")
	}
	sessionID := sessionCookie.Value

	// Step 2: Validate Azure — passes the existing ddi_session cookie.
	// The handler should reuse the session instead of creating a new one.
	azureBody, _ := json.Marshal(map[string]interface{}{
		"authMethod": "service-principal",
		"credentials": map[string]string{
			"tenantId":     "tenant-123",
			"clientId":     "client-456",
			"clientSecret": "azure-secret",
		},
	})
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/providers/azure/validate", bytes.NewReader(azureBody))
	req2.Header.Set("Content-Type", "application/json")
	req2.AddCookie(sessionCookie) // pass the cookie from step 1
	rec2 := httptest.NewRecorder()
	router.ServeHTTP(rec2, req2)

	if rec2.Code != http.StatusOK {
		t.Fatalf("Azure validate: expected 200, got %d: %s", rec2.Code, rec2.Body.String())
	}

	// The second response should NOT set a new cookie (session was reused).
	for _, c := range (&http.Response{Header: rec2.Header()}).Cookies() {
		if c.Name == "ddi_session" && c.Value != sessionID {
			t.Errorf("expected session reuse (same cookie), but got new session ID %q vs original %q", c.Value, sessionID)
		}
	}

	// Verify the single session has BOTH providers' credentials.
	sess, ok := store.Get(sessionID)
	if !ok {
		t.Fatal("session not found in store")
	}
	if sess.AWS == nil {
		t.Error("expected sess.AWS to be set (from first validation)")
	}
	if sess.Azure == nil {
		t.Error("expected sess.Azure to be set (from second validation)")
	}
	if sess.AWS != nil && sess.AWS.AccessKeyID != "AKIA-TEST" {
		t.Errorf("expected AWS AccessKeyID=%q, got %q", "AKIA-TEST", sess.AWS.AccessKeyID)
	}
	if sess.Azure != nil && sess.Azure.TenantID != "tenant-123" {
		t.Errorf("expected Azure TenantID=%q, got %q", "tenant-123", sess.Azure.TenantID)
	}
}

// ---------------------------------------------------------------------------
// Bluecat / EfficientIP / NIOS WAPI prefixed-key tests
//
// The frontend sends provider-prefixed keys (bluecat_url, efficientip_url,
// wapi_url) and snake_case fields (skip_tls, configuration_ids, site_ids).
// These tests verify storeCredentials reads those prefixed keys correctly.
// ---------------------------------------------------------------------------

// TestStoreCredentials_BluecatPrefixedKeys: POST bluecat validate with prefixed keys
// → session.Bluecat has all fields populated correctly.
func TestStoreCredentials_BluecatPrefixedKeys(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
	h.BluecatValidator = stubOKValidator([]server.SubscriptionItem{{ID: "bluecat", Name: "BlueCat (API v2)"}})

	rec := postValidate(t, store, h, "bluecat", map[string]interface{}{
		"authMethod": "credentials",
		"credentials": map[string]string{
			"bluecat_url":       "https://bam.example.com",
			"bluecat_username":  "admin",
			"bluecat_password":  "secret",
			"skip_tls":          "true",
			"configuration_ids": "42,99",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := &http.Response{Header: rec.Header()}
	var sessionID string
	for _, c := range resp.Cookies() {
		if c.Name == "ddi_session" {
			sessionID = c.Value
			break
		}
	}
	if sessionID == "" {
		t.Fatal("expected ddi_session cookie")
	}

	sess, ok := store.Get(sessionID)
	if !ok {
		t.Fatal("session not found in store")
	}
	if sess.Bluecat == nil {
		t.Fatal("expected sess.Bluecat to be set")
	}
	if sess.Bluecat.URL != "https://bam.example.com" {
		t.Errorf("expected URL=%q, got %q", "https://bam.example.com", sess.Bluecat.URL)
	}
	if sess.Bluecat.Username != "admin" {
		t.Errorf("expected Username=%q, got %q", "admin", sess.Bluecat.Username)
	}
	if sess.Bluecat.Password != "secret" {
		t.Errorf("expected Password=%q, got %q", "secret", sess.Bluecat.Password)
	}
	if !sess.Bluecat.SkipTLS {
		t.Error("expected SkipTLS=true")
	}
	if len(sess.Bluecat.ConfigurationIDs) != 2 || sess.Bluecat.ConfigurationIDs[0] != "42" || sess.Bluecat.ConfigurationIDs[1] != "99" {
		t.Errorf("expected ConfigurationIDs=[42,99], got %v", sess.Bluecat.ConfigurationIDs)
	}
}

// TestStoreCredentials_EfficientIPPrefixedKeys: POST efficientip validate with prefixed keys
// → session.EfficientIP has all fields populated correctly.
func TestStoreCredentials_EfficientIPPrefixedKeys(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
	h.EfficientIPValidator = stubOKValidator([]server.SubscriptionItem{{ID: "efficientip", Name: "EfficientIP (Basic auth)"}})

	rec := postValidate(t, store, h, "efficientip", map[string]interface{}{
		"authMethod": "credentials",
		"credentials": map[string]string{
			"efficientip_url":      "https://eip.example.com",
			"efficientip_username": "admin",
			"efficientip_password": "secret",
			"skip_tls":             "true",
			"site_ids":             "10,20",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := &http.Response{Header: rec.Header()}
	var sessionID string
	for _, c := range resp.Cookies() {
		if c.Name == "ddi_session" {
			sessionID = c.Value
			break
		}
	}
	if sessionID == "" {
		t.Fatal("expected ddi_session cookie")
	}

	sess, ok := store.Get(sessionID)
	if !ok {
		t.Fatal("session not found in store")
	}
	if sess.EfficientIP == nil {
		t.Fatal("expected sess.EfficientIP to be set")
	}
	if sess.EfficientIP.URL != "https://eip.example.com" {
		t.Errorf("expected URL=%q, got %q", "https://eip.example.com", sess.EfficientIP.URL)
	}
	if sess.EfficientIP.Username != "admin" {
		t.Errorf("expected Username=%q, got %q", "admin", sess.EfficientIP.Username)
	}
	if sess.EfficientIP.Password != "secret" {
		t.Errorf("expected Password=%q, got %q", "secret", sess.EfficientIP.Password)
	}
	if !sess.EfficientIP.SkipTLS {
		t.Error("expected SkipTLS=true")
	}
	if len(sess.EfficientIP.SiteIDs) != 2 || sess.EfficientIP.SiteIDs[0] != "10" || sess.EfficientIP.SiteIDs[1] != "20" {
		t.Errorf("expected SiteIDs=[10,20], got %v", sess.EfficientIP.SiteIDs)
	}
}

// TestStoreCredentials_NiosWAPIPrefixedKeys: POST nios validate with authMethod="wapi"
// and prefixed keys → session.NiosWAPI has all fields populated correctly.
func TestStoreCredentials_NiosWAPIPrefixedKeys(t *testing.T) {
	store := session.NewStore()
	h := newTestValidateHandler(store)
	h.NiosWAPIValidator = stubOKValidator([]server.SubscriptionItem{{ID: "nios", Name: "NIOS Grid"}})

	rec := postValidate(t, store, h, "nios", map[string]interface{}{
		"authMethod": "wapi",
		"credentials": map[string]string{
			"wapi_url":      "https://nios.example.com",
			"wapi_username": "admin",
			"wapi_password": "secret",
			"skip_tls":      "true",
			"wapi_version":  "2.13.7",
		},
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	resp := &http.Response{Header: rec.Header()}
	var sessionID string
	for _, c := range resp.Cookies() {
		if c.Name == "ddi_session" {
			sessionID = c.Value
			break
		}
	}
	if sessionID == "" {
		t.Fatal("expected ddi_session cookie")
	}

	sess, ok := store.Get(sessionID)
	if !ok {
		t.Fatal("session not found in store")
	}
	if sess.NiosWAPI == nil {
		t.Fatal("expected sess.NiosWAPI to be set")
	}
	if sess.NiosWAPI.URL != "https://nios.example.com" {
		t.Errorf("expected URL=%q, got %q", "https://nios.example.com", sess.NiosWAPI.URL)
	}
	if sess.NiosWAPI.Username != "admin" {
		t.Errorf("expected Username=%q, got %q", "admin", sess.NiosWAPI.Username)
	}
	if sess.NiosWAPI.Password != "secret" {
		t.Errorf("expected Password=%q, got %q", "secret", sess.NiosWAPI.Password)
	}
	if !sess.NiosWAPI.SkipTLS {
		t.Error("expected SkipTLS=true")
	}
	if sess.NiosWAPI.ExplicitVersion != "2.13.7" {
		t.Errorf("expected ExplicitVersion=%q, got %q", "2.13.7", sess.NiosWAPI.ExplicitVersion)
	}
}

// TestValidate_BluecatMissingField: POST bluecat validate with empty prefixed keys
// → valid=false, error mentions required fields.
func TestValidate_BluecatMissingField(t *testing.T) {
	store := session.NewStore()
	// Use REAL validator so the error path fires.
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "bluecat", map[string]interface{}{
		"authMethod": "credentials",
		"credentials": map[string]string{
			"bluecat_url":      "",
			"bluecat_username": "",
			"bluecat_password": "",
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
		t.Error("expected valid=false for missing bluecat credentials")
	}
	if !strings.Contains(resp.Error, "required") {
		t.Errorf("expected error to mention 'required', got %q", resp.Error)
	}
}

// TestValidate_EfficientIPMissingField: POST efficientip validate with empty prefixed keys
// → valid=false, error mentions required fields.
func TestValidate_EfficientIPMissingField(t *testing.T) {
	store := session.NewStore()
	// Use REAL validator so the error path fires.
	h := server.NewValidateHandler(store)
	rec := postValidate(t, store, h, "efficientip", map[string]interface{}{
		"authMethod": "credentials",
		"credentials": map[string]string{
			"efficientip_url":      "",
			"efficientip_username": "",
			"efficientip_password": "",
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
		t.Error("expected valid=false for missing efficientip credentials")
	}
	if !strings.Contains(resp.Error, "required") {
		t.Errorf("expected error to mention 'required', got %q", resp.Error)
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
