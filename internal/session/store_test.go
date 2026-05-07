package session_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
)

// Test 1: NewStore() returns non-nil Store
func TestStore_New_NonNil(t *testing.T) {
	s := session.NewStore()
	if s == nil {
		t.Fatal("NewStore() returned nil")
	}
}

// Test 2: store.New() creates a Session with a non-empty crypto-random ID (at least 16 hex chars)
func TestStore_New_CryptoRandomID(t *testing.T) {
	s := session.NewStore()
	sess := s.New()
	if sess == nil {
		t.Fatal("store.New() returned nil session")
	}
	if len(sess.ID) < 16 {
		t.Errorf("session ID too short: %q (len=%d, want >= 16)", sess.ID, len(sess.ID))
	}
	// Verify it looks like hex (all chars in 0-9a-f)
	for _, c := range sess.ID {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("session ID contains non-hex character %q in ID %q", c, sess.ID)
		}
	}
}

// Test 3: store.Get(id) returns the session created by store.New()
func TestStore_Get_ReturnsCreatedSession(t *testing.T) {
	s := session.NewStore()
	sess := s.New()

	got, ok := s.Get(sess.ID)
	if !ok {
		t.Fatalf("Get(%q) returned ok=false", sess.ID)
	}
	if got == nil {
		t.Fatal("Get returned nil session")
	}
	if got.ID != sess.ID {
		t.Errorf("Get returned session with ID %q, want %q", got.ID, sess.ID)
	}
}

// Test 4: store.Get("nonexistent") returns nil, false
func TestStore_Get_Nonexistent(t *testing.T) {
	s := session.NewStore()
	got, ok := s.Get("does-not-exist")
	if ok {
		t.Error("Get(nonexistent) returned ok=true")
	}
	if got != nil {
		t.Errorf("Get(nonexistent) returned non-nil session: %+v", got)
	}
}

// Test 5: store.Delete(id) removes the session; subsequent Get returns nil, false
func TestStore_Delete(t *testing.T) {
	s := session.NewStore()
	sess := s.New()

	s.Delete(sess.ID)

	got, ok := s.Get(sess.ID)
	if ok {
		t.Error("Get after Delete returned ok=true")
	}
	if got != nil {
		t.Errorf("Get after Delete returned non-nil session: %+v", got)
	}
}

// Test 6: Session struct has no exported json tags on Credentials fields
// (credentials must never be accidentally serialized)
func TestSession_NoJsonTagsOnCredentials(t *testing.T) {
	// Verify that AWSCredentials has no json tags on any field
	awsType := reflect.TypeOf(session.AWSCredentials{})
	for i := 0; i < awsType.NumField(); i++ {
		field := awsType.Field(i)
		if tag, ok := field.Tag.Lookup("json"); ok && tag != "" {
			t.Errorf("AWSCredentials.%s has json tag %q — credentials must not be serialized", field.Name, tag)
		}
	}

	azureType := reflect.TypeOf(session.AzureCredentials{})
	for i := 0; i < azureType.NumField(); i++ {
		field := azureType.Field(i)
		if tag, ok := field.Tag.Lookup("json"); ok && tag != "" {
			t.Errorf("AzureCredentials.%s has json tag %q — credentials must not be serialized", field.Name, tag)
		}
	}

	gcpType := reflect.TypeOf(session.GCPCredentials{})
	for i := 0; i < gcpType.NumField(); i++ {
		field := gcpType.Field(i)
		if tag, ok := field.Tag.Lookup("json"); ok && tag != "" {
			t.Errorf("GCPCredentials.%s has json tag %q — credentials must not be serialized", field.Name, tag)
		}
	}

	adType := reflect.TypeOf(session.ADCredentials{})
	for i := 0; i < adType.NumField(); i++ {
		field := adType.Field(i)
		if tag, ok := field.Tag.Lookup("json"); ok && tag != "" {
			t.Errorf("ADCredentials.%s has json tag %q — credentials must not be serialized", field.Name, tag)
		}
	}

	// Also verify that marshaling a Session containing fake credentials does NOT
	// include the credential values in the JSON output.
	sess := &session.Session{
		ID: "test-id",
		AWS: &session.AWSCredentials{
			AccessKeyID:     "AKIAIOSFODNN7EXAMPLE",
			SecretAccessKey: "super-secret-key",
		},
		Azure: &session.AzureCredentials{
			ClientSecret: "azure-secret",
		},
		GCP: &session.GCPCredentials{
			ServiceAccountJSON: `{"type":"service_account"}`,
		},
		AD: &session.ADCredentials{
			Password: "ad-password",
		},
	}

	data, err := json.Marshal(sess)
	if err != nil {
		t.Fatalf("json.Marshal(Session) failed: %v", err)
	}

	jsonStr := string(data)
	sensitiveValues := []string{
		"AKIAIOSFODNN7EXAMPLE",
		"super-secret-key",
		"azure-secret",
		`{"type":"service_account"}`,
		"ad-password",
	}
	for _, v := range sensitiveValues {
		if containsSubstring(jsonStr, v) {
			t.Errorf("credential value %q found in marshaled JSON — credentials are leaking: %s", v, jsonStr)
		}
	}
}

func containsSubstring(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsAt(s, sub))
}

func containsAt(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// Test 7: Two calls to store.New() produce different session IDs
func TestStore_New_UniqueIDs(t *testing.T) {
	s := session.NewStore()
	sess1 := s.New()
	sess2 := s.New()

	if sess1.ID == sess2.ID {
		t.Errorf("Two consecutive store.New() calls produced the same ID: %q", sess1.ID)
	}
}

// Test 8: ScanState constants exist and are distinct
func TestScanState_Constants(t *testing.T) {
	states := []session.ScanState{
		session.ScanStateCreated,
		session.ScanStateScanning,
		session.ScanStateComplete,
		session.ScanStateFailed,
	}

	seen := make(map[session.ScanState]bool)
	for _, s := range states {
		if seen[s] {
			t.Errorf("ScanState constant %q is duplicated", s)
		}
		seen[s] = true
		if string(s) == "" {
			t.Error("ScanState constant is empty string")
		}
	}

	// Verify initial state from store.New() is ScanStateCreated
	store := session.NewStore()
	sess := store.New()
	if sess.State != session.ScanStateCreated {
		t.Errorf("new session State = %q, want %q", sess.State, session.ScanStateCreated)
	}
}

// Additional test: ZeroCreds() zeros all credential pointer fields
func TestSession_ZeroCreds(t *testing.T) {
	store := session.NewStore()
	sess := store.New()
	sess.AWS = &session.AWSCredentials{AccessKeyID: "test"}
	sess.Azure = &session.AzureCredentials{ClientSecret: "secret"}
	sess.GCP = &session.GCPCredentials{ProjectID: "my-project"}
	sess.AD = &session.ADCredentials{Password: "pw"}

	sess.ZeroCreds()

	if sess.AWS != nil {
		t.Error("ZeroCreds() did not nil AWS credentials")
	}
	if sess.Azure != nil {
		t.Error("ZeroCreds() did not nil Azure credentials")
	}
	if sess.GCP != nil {
		t.Error("ZeroCreds() did not nil GCP credentials")
	}
	if sess.AD != nil {
		t.Error("ZeroCreds() did not nil AD credentials")
	}
}

// Additional test: StartedAt is populated on session creation
func TestSession_StartedAt(t *testing.T) {
	before := time.Now()
	store := session.NewStore()
	sess := store.New()
	after := time.Now()

	if sess.StartedAt.Before(before) || sess.StartedAt.After(after) {
		t.Errorf("StartedAt %v not between %v and %v", sess.StartedAt, before, after)
	}
}
