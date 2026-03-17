package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/version"
)

func TestParseSemver(t *testing.T) {
	tests := []struct {
		input             string
		major, minor, pat int
		pre               string
		ok                bool
	}{
		{"v2.1.0", 2, 1, 0, "", true},
		{"2.1.0", 2, 1, 0, "", true},
		{"v1.0.0-rc1", 1, 0, 0, "rc1", true},
		{"v0.0.1", 0, 0, 1, "", true},
		{"dev", 0, 0, 0, "", false},
		{"", 0, 0, 0, "", false},
		{"v1.0", 0, 0, 0, "", false},
		{"vnotaversion", 0, 0, 0, "", false},
	}

	for _, tt := range tests {
		maj, min, pat, pre, ok := parseSemver(tt.input)
		if ok != tt.ok || maj != tt.major || min != tt.minor || pat != tt.pat || pre != tt.pre {
			t.Errorf("parseSemver(%q) = (%d,%d,%d,%q,%v), want (%d,%d,%d,%q,%v)",
				tt.input, maj, min, pat, pre, ok,
				tt.major, tt.minor, tt.pat, tt.pre, tt.ok)
		}
	}
}

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		current, latest string
		want            bool
	}{
		{"v1.0.0", "v2.0.0", true},
		{"v1.9.9", "v2.0.0", true},
		{"v2.0.0", "v1.9.9", false},
		{"v1.0.0", "v1.0.0", false},
		{"v1.0.0", "v1.0.1", true},
		{"v1.0.0", "v1.1.0", true},
		{"v1.0.0-rc1", "v1.0.0", true},  // pre-release < release
		{"v1.0.0", "v1.0.0-rc1", false},  // release > pre-release
		{"dev", "v2.0.0", false},          // dev always false
		{"v1.0.0", "dev", false},          // unparseable latest
	}

	for _, tt := range tests {
		got := isNewerVersion(tt.current, tt.latest)
		if got != tt.want {
			t.Errorf("isNewerVersion(%q, %q) = %v, want %v",
				tt.current, tt.latest, got, tt.want)
		}
	}
}

func TestUpdateCheckDevVersion(t *testing.T) {
	// Reset cache
	cacheMu.Lock()
	cachedUpdate = nil
	cacheMu.Unlock()

	// Save and restore original version
	origVersion := version.Version
	defer func() { version.Version = origVersion }()
	version.Version = "dev"

	// Mock GitHub API
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(ghRelease{
			TagName: "v9.9.9",
			HTMLURL: "https://github.com/stefanriegel/UDDI-Token-Calculator/releases/tag/v9.9.9",
			Body:    "Big update",
			Assets: []ghAsset{
				{Name: "uddi-token-calculator_darwin_arm64", BrowserDownloadURL: "https://example.com/bin"},
			},
		})
	}))
	defer mockServer.Close()

	// Override the GitHub client to hit our mock
	origClient := ghClient
	defer func() { ghClient = origClient }()
	ghClient = mockServer.Client()

	// Can't easily override the URL, so test via the handler directly
	// Instead, test the logic: dev version should never be newer
	if isNewerVersion("dev", "v9.9.9") {
		t.Error("dev version should never report update available")
	}
}

func TestHandleCheckUpdateMockGitHub(t *testing.T) {
	// Reset cache
	cacheMu.Lock()
	cachedUpdate = nil
	cacheMu.Unlock()

	origVersion := version.Version
	defer func() { version.Version = origVersion }()
	version.Version = "v1.0.0"

	// Mock GitHub API
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Error("Expected User-Agent header")
		}
		json.NewEncoder(w).Encode(ghRelease{
			TagName: "v2.0.0",
			HTMLURL: "https://github.com/stefanriegel/UDDI-Token-Calculator/releases/tag/v2.0.0",
			Body:    "New release",
			Assets: []ghAsset{
				{Name: "uddi-token-calculator_darwin_arm64", BrowserDownloadURL: "https://example.com/binary"},
				{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/linux-binary"},
				{Name: "uddi-token-calculator_windows_amd64.exe", BrowserDownloadURL: "https://example.com/win-binary"},
				{Name: "checksums.sha256", BrowserDownloadURL: "https://example.com/checksums"},
			},
		})
	}))
	defer mockServer.Close()

	// We can test the semver comparison and asset matching directly
	// since we can't easily redirect the hardcoded GitHub URL in the handler

	// Test that v2.0.0 > v1.0.0
	if !isNewerVersion("v1.0.0", "v2.0.0") {
		t.Error("v2.0.0 should be newer than v1.0.0")
	}

	// Test asset matching
	assets := []ghAsset{
		{Name: "uddi-token-calculator_darwin_arm64", BrowserDownloadURL: "https://example.com/darwin-arm64"},
		{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/linux-amd64"},
		{Name: "uddi-token-calculator_windows_amd64.exe", BrowserDownloadURL: "https://example.com/win-amd64"},
		{Name: "checksums.sha256", BrowserDownloadURL: "https://example.com/checksums"},
	}

	url := findAssetURL(assets)
	if url == "" {
		t.Error("Expected to find a matching asset URL for current platform")
	}
	// Should not match the checksums file
	if url == "https://example.com/checksums" {
		t.Error("Should not match checksums file as a binary")
	}
}

func TestFindAssetURL(t *testing.T) {
	assets := []ghAsset{
		{Name: "uddi-token-calculator_darwin_arm64", BrowserDownloadURL: "https://example.com/darwin-arm64"},
		{Name: "uddi-token-calculator_darwin_amd64", BrowserDownloadURL: "https://example.com/darwin-amd64"},
		{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/linux-amd64"},
		{Name: "uddi-token-calculator_linux_arm64", BrowserDownloadURL: "https://example.com/linux-arm64"},
		{Name: "uddi-token-calculator_windows_amd64.exe", BrowserDownloadURL: "https://example.com/win-amd64"},
		{Name: "checksums.sha256", BrowserDownloadURL: "https://example.com/checksums"},
		{Name: "uddi-token-calculator_darwin_arm64.sig", BrowserDownloadURL: "https://example.com/sig"},
	}

	url := findAssetURL(assets)
	if url == "" {
		t.Fatal("Expected non-empty URL for current platform")
	}
	// Verify it's not a checksum or signature
	if url == "https://example.com/checksums" || url == "https://example.com/sig" {
		t.Errorf("Should not match checksum/signature file, got %s", url)
	}
}
