// Package efficientip -- live integration tests for the EfficientIP SOLIDserver scanner.
//
// These tests require a real SOLIDserver instance reachable at EFFICIENTIP_URL.
// When EFFICIENTIP_URL is not set, all four tests skip cleanly.
//
// # Required environment variables (credentials auth)
//
//	EFFICIENTIP_URL       -- base URL of the SOLIDserver, e.g. https://localhost:8443
//	EFFICIENTIP_USERNAME  -- admin username
//	EFFICIENTIP_PASSWORD  -- admin password
//	EFFICIENTIP_SKIP_TLS  -- set to "true" or "1" to skip TLS certificate verification
//
// # Additional environment variables (token auth)
//
//	EFFICIENTIP_TOKEN_ID      -- SDS token ID
//	EFFICIENTIP_TOKEN_SECRET  -- SDS token secret
//
// # SSH tunnel setup (target host is on an isolated network segment)
//
// The test SOLIDserver is on an internal network segment, not publicly routable.
// It is reachable through a jumphost on a separate Tailscale tailnet (tail14b13c).
// Node sharing must be enabled on that tailnet before the jumphost is reachable.
//
// Forward local port 8443 to the SOLIDserver HTTPS port via the jumphost
// (replace <solidserver-host> with the actual internal address or hostname):
//
//	ssh -L 8443:<solidserver-host>:443 dominik@ubuntu.tail14b13c.ts.net -N &
//
// Then set your env vars and run the tests:
//
//	export EFFICIENTIP_URL=https://localhost:8443
//	export EFFICIENTIP_USERNAME=ipadmin
//	export EFFICIENTIP_PASSWORD=ipadmin
//	export EFFICIENTIP_SKIP_TLS=true
//	go test ./internal/scanner/efficientip/... -run TestLive -v -timeout 120s
//
// For token auth additionally set:
//
//	export EFFICIENTIP_TOKEN_ID=<your-token-id>
//	export EFFICIENTIP_TOKEN_SECRET=<your-token-secret>
package efficientip

import (
	"context"
	"os"
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// liveSkip skips the test when EFFICIENTIP_URL is not set and returns the URL when it is.
func liveSkip(t *testing.T) string {
	t.Helper()
	url := os.Getenv("EFFICIENTIP_URL")
	if url == "" {
		t.Skip("skipping live test: EFFICIENTIP_URL not set")
	}
	return url
}

// mustEnv skips the test when the named environment variable is not set and returns its value.
func mustEnv(t *testing.T, key string) string {
	t.Helper()
	val := os.Getenv(key)
	if val == "" {
		t.Skipf("skipping live test: %s not set", key)
	}
	return val
}

// TestLiveScan_Credentials_Legacy scans a real SOLIDserver using username/password
// auth and the legacy REST API (/rest/... paths).
func TestLiveScan_Credentials_Legacy(t *testing.T) {
	url := liveSkip(t)
	username := mustEnv(t, "EFFICIENTIP_USERNAME")
	password := mustEnv(t, "EFFICIENTIP_PASSWORD")

	skipTLS := "false"
	if v := os.Getenv("EFFICIENTIP_SKIP_TLS"); v == "true" || v == "1" {
		skipTLS = "true"
	}

	s := Scanner{}
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":         url,
			"efficientip_username":    username,
			"efficientip_password":    password,
			"skip_tls":                skipTLS,
			"efficientip_auth_method": "credentials",
			"efficientip_api_version": "legacy",
		},
	}

	rows, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	for _, row := range rows {
		t.Logf("FindingRow: provider=%s source=%s region=%s category=%s item=%s count=%d tokens=%d",
			row.Provider, row.Source, row.Region, row.Category, row.Item, row.Count, row.ManagementTokens)
	}
	t.Logf("Total rows: %d", len(rows))
}

// TestLiveScan_Credentials_V2 scans a real SOLIDserver using username/password
// auth and the v2 REST API (/api/v2.0/... paths).
func TestLiveScan_Credentials_V2(t *testing.T) {
	url := liveSkip(t)
	username := mustEnv(t, "EFFICIENTIP_USERNAME")
	password := mustEnv(t, "EFFICIENTIP_PASSWORD")

	skipTLS := "false"
	if v := os.Getenv("EFFICIENTIP_SKIP_TLS"); v == "true" || v == "1" {
		skipTLS = "true"
	}

	s := Scanner{}
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":         url,
			"efficientip_username":    username,
			"efficientip_password":    password,
			"skip_tls":                skipTLS,
			"efficientip_auth_method": "credentials",
			"efficientip_api_version": "v2",
		},
	}

	rows, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	for _, row := range rows {
		t.Logf("FindingRow: provider=%s source=%s region=%s category=%s item=%s count=%d tokens=%d",
			row.Provider, row.Source, row.Region, row.Category, row.Item, row.Count, row.ManagementTokens)
	}
	t.Logf("Total rows: %d", len(rows))
}

// TestLiveScan_Token_Legacy scans a real SOLIDserver using SDS token auth
// and the legacy REST API (/rest/... paths).
func TestLiveScan_Token_Legacy(t *testing.T) {
	url := liveSkip(t)
	tokenID := mustEnv(t, "EFFICIENTIP_TOKEN_ID")
	tokenSecret := mustEnv(t, "EFFICIENTIP_TOKEN_SECRET")

	skipTLS := "false"
	if v := os.Getenv("EFFICIENTIP_SKIP_TLS"); v == "true" || v == "1" {
		skipTLS = "true"
	}

	s := Scanner{}
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":          url,
			"efficientip_token_id":     tokenID,
			"efficientip_token_secret": tokenSecret,
			"skip_tls":                 skipTLS,
			"efficientip_auth_method":  "token",
			"efficientip_api_version":  "legacy",
		},
	}

	rows, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	for _, row := range rows {
		t.Logf("FindingRow: provider=%s source=%s region=%s category=%s item=%s count=%d tokens=%d",
			row.Provider, row.Source, row.Region, row.Category, row.Item, row.Count, row.ManagementTokens)
	}
	t.Logf("Total rows: %d", len(rows))
}

// TestLiveScan_Token_V2 scans a real SOLIDserver using SDS token auth
// and the v2 REST API (/api/v2.0/... paths).
func TestLiveScan_Token_V2(t *testing.T) {
	url := liveSkip(t)
	tokenID := mustEnv(t, "EFFICIENTIP_TOKEN_ID")
	tokenSecret := mustEnv(t, "EFFICIENTIP_TOKEN_SECRET")

	skipTLS := "false"
	if v := os.Getenv("EFFICIENTIP_SKIP_TLS"); v == "true" || v == "1" {
		skipTLS = "true"
	}

	s := Scanner{}
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":          url,
			"efficientip_token_id":     tokenID,
			"efficientip_token_secret": tokenSecret,
			"skip_tls":                 skipTLS,
			"efficientip_auth_method":  "token",
			"efficientip_api_version":  "v2",
		},
	}

	rows, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	for _, row := range rows {
		t.Logf("FindingRow: provider=%s source=%s region=%s category=%s item=%s count=%d tokens=%d",
			row.Provider, row.Source, row.Region, row.Category, row.Item, row.Count, row.ManagementTokens)
	}
	t.Logf("Total rows: %d", len(rows))
}
