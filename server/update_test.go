package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/version"
)

// resetUpdateState clears the update cache and saves/restores version.Version,
// version.Channel, and ghReleasesURL. Usage: defer resetUpdateState(t)()
func resetUpdateState(t *testing.T) func() {
	t.Helper()
	origVersion := version.Version
	origChannel := version.Channel
	origURL := ghReleasesURL

	// Clear cache immediately
	cacheMu.Lock()
	cachedUpdate = nil
	cachedUpdateTime = time.Time{}
	cacheMu.Unlock()

	return func() {
		version.Version = origVersion
		version.Channel = origChannel
		ghReleasesURL = origURL
		cacheMu.Lock()
		cachedUpdate = nil
		cachedUpdateTime = time.Time{}
		cacheMu.Unlock()
	}
}

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

// --- Channel-aware tests (T02) ---

func TestIsNewerVersionDevSuffix(t *testing.T) {
	tests := []struct {
		current, latest string
		want            bool
		desc            string
	}{
		{"v2.4.0-dev.1", "v2.4.0-dev.2", true, "dev.2 > dev.1"},
		{"v2.4.0-dev.2", "v2.4.0-dev.1", false, "dev.1 < dev.2"},
		{"v2.4.0-dev.1", "v2.4.0-dev.1", false, "same dev version"},
		{"v2.4.0-dev.2", "v2.4.0-dev.10", true, "numeric not lexicographic: dev.10 > dev.2"},
		{"v2.4.0-dev.1", "v2.5.0-dev.1", true, "higher minor wins regardless of dev suffix"},
		{"v2.4.0-dev.5", "v2.4.0", true, "pre-release < release"},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			got := isNewerVersion(tt.current, tt.latest)
			if got != tt.want {
				t.Errorf("isNewerVersion(%q, %q) = %v, want %v", tt.current, tt.latest, got, tt.want)
			}
		})
	}
}

func TestChannelStableSeesStableUpdate(t *testing.T) {
	defer resetUpdateState(t)()

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Stable channel hits /releases/latest
		json.NewEncoder(w).Encode(ghRelease{
			TagName:    "v2.0.0",
			HTMLURL:    "https://github.com/example/releases/tag/v2.0.0",
			Body:       "Stable release",
			Prerelease: false,
			Assets: []ghAsset{
				{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/linux"},
			},
		})
	}))
	defer mockServer.Close()

	version.Version = "v1.0.0"
	version.Channel = "stable"
	ghReleasesURL = mockServer.URL + "/releases"

	result, err := checkUpdateFromGitHub()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.UpdateAvailable {
		t.Error("expected UpdateAvailable=true for stable v1.0.0 -> v2.0.0")
	}
	if result.LatestVersion != "v2.0.0" {
		t.Errorf("expected LatestVersion=v2.0.0, got %s", result.LatestVersion)
	}
}

func TestChannelStableIgnoresPreRelease(t *testing.T) {
	defer resetUpdateState(t)()

	// The /releases/latest endpoint never returns pre-releases by GitHub design.
	// This test proves stable channel uses /latest and sees only the stable release.
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases/latest" {
			t.Errorf("stable channel should hit /releases/latest, got %s", r.URL.Path)
		}
		// Return a stable release at the same version — no update available
		json.NewEncoder(w).Encode(ghRelease{
			TagName:    "v2.0.0",
			HTMLURL:    "https://github.com/example/releases/tag/v2.0.0",
			Body:       "Stable only",
			Prerelease: false,
		})
	}))
	defer mockServer.Close()

	version.Version = "v2.0.0"
	version.Channel = "stable"
	ghReleasesURL = mockServer.URL + "/releases"

	result, err := checkUpdateFromGitHub()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.UpdateAvailable {
		t.Error("stable channel at v2.0.0 should not see an update to v2.0.0")
	}
	// Verify we never see a pre-release tag
	if result.LatestVersion != "v2.0.0" {
		t.Errorf("expected LatestVersion=v2.0.0, got %s", result.LatestVersion)
	}
}

func TestChannelDevSeesNewerPreRelease(t *testing.T) {
	defer resetUpdateState(t)()

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Dev channel hits ?per_page=20
		json.NewEncoder(w).Encode([]ghRelease{
			{
				TagName:    "v2.4.0-dev.2",
				HTMLURL:    "https://github.com/example/releases/tag/v2.4.0-dev.2",
				Body:       "Dev pre-release",
				Prerelease: true,
				Assets: []ghAsset{
					{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/dev-linux"},
				},
			},
			{
				TagName:    "v2.3.0",
				HTMLURL:    "https://github.com/example/releases/tag/v2.3.0",
				Body:       "Stable release",
				Prerelease: false,
			},
		})
	}))
	defer mockServer.Close()

	version.Version = "v2.4.0-dev.1"
	version.Channel = "dev"
	ghReleasesURL = mockServer.URL + "/releases"

	result, err := checkUpdateFromGitHub()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.UpdateAvailable {
		t.Error("expected UpdateAvailable=true for dev v2.4.0-dev.1 -> v2.4.0-dev.2")
	}
	if result.LatestVersion != "v2.4.0-dev.2" {
		t.Errorf("expected LatestVersion=v2.4.0-dev.2, got %s", result.LatestVersion)
	}
}

func TestChannelDevPicksHighestPreRelease(t *testing.T) {
	defer resetUpdateState(t)()

	// Simulate GitHub returning pre-releases out of semver order (as observed in production)
	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]ghRelease{
			{TagName: "v2.4.0-dev.9", Prerelease: true, Assets: []ghAsset{{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/9"}}},
			{TagName: "v2.4.0-dev.8", Prerelease: true, Assets: []ghAsset{{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/8"}}},
			{TagName: "v2.4.0-dev.11", Prerelease: true, Assets: []ghAsset{{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/11"}}},
			{TagName: "v2.4.0-dev.10", Prerelease: true, Assets: []ghAsset{{Name: "uddi-token-calculator_linux_amd64", BrowserDownloadURL: "https://example.com/10"}}},
		})
	}))
	defer mockServer.Close()

	version.Version = "v2.4.0-dev.9"
	version.Channel = "dev"
	ghReleasesURL = mockServer.URL + "/releases"

	result, err := checkUpdateFromGitHub()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.UpdateAvailable {
		t.Error("expected UpdateAvailable=true: dev.11 is newer than dev.9")
	}
	if result.LatestVersion != "v2.4.0-dev.11" {
		t.Errorf("expected LatestVersion=v2.4.0-dev.11, got %s", result.LatestVersion)
	}
}

func TestChannelDevNoPreReleasesAvailable(t *testing.T) {
	defer resetUpdateState(t)()

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Return only stable releases — no pre-releases
		json.NewEncoder(w).Encode([]ghRelease{
			{TagName: "v2.3.0", Prerelease: false},
			{TagName: "v2.2.0", Prerelease: false},
		})
	}))
	defer mockServer.Close()

	version.Version = "v2.3.0-dev.1"
	version.Channel = "dev"
	ghReleasesURL = mockServer.URL + "/releases"

	result, err := checkUpdateFromGitHub()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.UpdateAvailable {
		t.Error("expected UpdateAvailable=false when no pre-releases exist")
	}
}

func TestChannelDevRateLimitGracefulFail(t *testing.T) {
	defer resetUpdateState(t)()

	mockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	}))
	defer mockServer.Close()

	version.Version = "v2.4.0-dev.1"
	version.Channel = "dev"
	ghReleasesURL = mockServer.URL + "/releases"

	// Direct call should return error
	_, err := checkUpdateFromGitHub()
	if err == nil {
		t.Fatal("expected error from checkUpdateFromGitHub on 403")
	}

	// Clear cache so handler re-fetches
	cacheMu.Lock()
	cachedUpdate = nil
	cacheMu.Unlock()

	// Handler should swallow the error and return HTTP 200 with updateAvailable=false
	req := httptest.NewRequest("GET", "/api/v1/update/check", nil)
	w := httptest.NewRecorder()
	HandleCheckUpdate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", w.Code)
	}

	var resp UpdateCheckResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.UpdateAvailable {
		t.Error("expected updateAvailable=false on rate limit error")
	}
}

func TestChannelDevNetworkErrorGracefulFail(t *testing.T) {
	defer resetUpdateState(t)()

	version.Version = "v2.4.0-dev.1"
	version.Channel = "dev"
	// RFC 5737 TEST-NET address — guaranteed unreachable
	ghReleasesURL = "http://192.0.2.1:1/releases"

	// Use a short-timeout client so the test doesn't hang
	origClient := ghClient
	defer func() { ghClient = origClient }()
	ghClient = &http.Client{Timeout: 1 * time.Second}

	// Direct call should return error
	_, err := checkUpdateFromGitHub()
	if err == nil {
		t.Fatal("expected error from checkUpdateFromGitHub on network failure")
	}

	// Clear cache so handler re-fetches
	cacheMu.Lock()
	cachedUpdate = nil
	cacheMu.Unlock()

	// Handler should swallow the error and return HTTP 200 with updateAvailable=false
	req := httptest.NewRequest("GET", "/api/v1/update/check", nil)
	w := httptest.NewRecorder()
	HandleCheckUpdate(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", w.Code)
	}

	var resp UpdateCheckResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.UpdateAvailable {
		t.Error("expected updateAvailable=false on network error")
	}
}
