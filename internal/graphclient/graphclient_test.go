package graphclient

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
)

// mockTokenCredential implements azcore.TokenCredential for testing.
type mockTokenCredential struct {
	token string
	err   error
}

func (m *mockTokenCredential) GetToken(_ context.Context, _ policy.TokenRequestOptions) (azcore.AccessToken, error) {
	if m.err != nil {
		return azcore.AccessToken{}, m.err
	}
	return azcore.AccessToken{
		Token:     m.token,
		ExpiresOn: time.Now().Add(1 * time.Hour),
	}, nil
}

func TestHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify required headers
		if r.Header.Get("ConsistencyLevel") != "eventual" {
			t.Errorf("missing ConsistencyLevel header")
		}
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected Authorization header: %s", r.Header.Get("Authorization"))
		}

		switch r.URL.Path {
		case "/users/$count":
			fmt.Fprint(w, "4200")
		case "/devices/$count":
			fmt.Fprint(w, "1850")
		default:
			t.Errorf("unexpected path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	origURL := graphBaseURL
	graphBaseURL = srv.URL
	defer func() { graphBaseURL = origURL }()

	cred := &mockTokenCredential{token: "test-token"}
	users, devices, err := FetchEntraCounts(context.Background(), cred)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if users != 4200 {
		t.Errorf("users = %d, want 4200", users)
	}
	if devices != 1850 {
		t.Errorf("devices = %d, want 1850", devices)
	}
}

func TestForbidden403(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"error":{"code":"Authorization_RequestDenied"}}`)
	}))
	defer srv.Close()

	origURL := graphBaseURL
	graphBaseURL = srv.URL
	defer func() { graphBaseURL = origURL }()

	cred := &mockTokenCredential{token: "test-token"}
	users, devices, err := FetchEntraCounts(context.Background(), cred)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if users != 0 {
		t.Errorf("users = %d, want 0", users)
	}
	if devices != 0 {
		t.Errorf("devices = %d, want 0", devices)
	}
}

func TestUnauthorized401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	origURL := graphBaseURL
	graphBaseURL = srv.URL
	defer func() { graphBaseURL = origURL }()

	cred := &mockTokenCredential{token: "test-token"}
	users, devices, err := FetchEntraCounts(context.Background(), cred)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if users != 0 {
		t.Errorf("users = %d, want 0", users)
	}
	if devices != 0 {
		t.Errorf("devices = %d, want 0", devices)
	}
}

func TestNilCredential(t *testing.T) {
	users, devices, err := FetchEntraCounts(context.Background(), nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if users != 0 {
		t.Errorf("users = %d, want 0", users)
	}
	if devices != 0 {
		t.Errorf("devices = %d, want 0", devices)
	}
}

func TestTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second) // longer than our test client timeout
		fmt.Fprint(w, "100")
	}))
	defer srv.Close()

	origURL := graphBaseURL
	graphBaseURL = srv.URL
	defer func() { graphBaseURL = origURL }()

	// Use a very short timeout to make the test fast
	origClient := httpClient
	httpClient = &http.Client{Timeout: 100 * time.Millisecond}
	defer func() { httpClient = origClient }()

	cred := &mockTokenCredential{token: "test-token"}
	users, devices, err := FetchEntraCounts(context.Background(), cred)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if users != 0 {
		t.Errorf("users = %d, want 0", users)
	}
	if devices != 0 {
		t.Errorf("devices = %d, want 0", devices)
	}
}

func TestTokenAcquisitionFailure(t *testing.T) {
	cred := &mockTokenCredential{err: fmt.Errorf("simulated auth failure")}
	users, devices, err := FetchEntraCounts(context.Background(), cred)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if users != 0 {
		t.Errorf("users = %d, want 0", users)
	}
	if devices != 0 {
		t.Errorf("devices = %d, want 0", devices)
	}
}
