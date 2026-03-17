package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/version"
)

// --- Cached update check ---

var (
	cachedUpdate     *UpdateCheckResponse
	cachedUpdateTime time.Time
	cacheMu          sync.Mutex
	cacheTTL         = 1 * time.Hour
)

// ghRelease is the subset of the GitHub Releases API response we need.
type ghRelease struct {
	TagName string    `json:"tag_name"`
	HTMLURL string    `json:"html_url"`
	Body    string    `json:"body"`
	Assets  []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// ghClient is the HTTP client used for GitHub API calls.
var ghClient = &http.Client{Timeout: 30 * time.Second}

// parseSemver extracts (major, minor, patch, prerelease) from a version string.
// Returns ok=false for unparseable versions (e.g. "dev").
func parseSemver(v string) (major, minor, patch int, pre string, ok bool) {
	v = strings.TrimPrefix(v, "v")
	if v == "" || v == "dev" {
		return 0, 0, 0, "", false
	}

	// Split off pre-release: "1.2.3-rc1" -> "1.2.3", "rc1"
	parts := strings.SplitN(v, "-", 2)
	core := parts[0]
	if len(parts) == 2 {
		pre = parts[1]
	}

	nums := strings.Split(core, ".")
	if len(nums) != 3 {
		return 0, 0, 0, "", false
	}

	var err error
	major, err = strconv.Atoi(nums[0])
	if err != nil {
		return 0, 0, 0, "", false
	}
	minor, err = strconv.Atoi(nums[1])
	if err != nil {
		return 0, 0, 0, "", false
	}
	patch, err = strconv.Atoi(nums[2])
	if err != nil {
		return 0, 0, 0, "", false
	}
	return major, minor, patch, pre, true
}

// isNewerVersion returns true if latest > current using semver comparison.
// Pre-release versions are considered older than the same release version.
func isNewerVersion(current, latest string) bool {
	cMaj, cMin, cPat, cPre, cOK := parseSemver(current)
	lMaj, lMin, lPat, lPre, lOK := parseSemver(latest)
	if !cOK || !lOK {
		return false
	}

	if lMaj != cMaj {
		return lMaj > cMaj
	}
	if lMin != cMin {
		return lMin > cMin
	}
	if lPat != cPat {
		return lPat > cPat
	}

	// Same version numbers — pre-release < release
	if cPre != "" && lPre == "" {
		return true // current is pre-release, latest is release
	}
	if cPre == "" && lPre != "" {
		return false // current is release, latest is pre-release
	}
	// Both pre-release or both release with same numbers — not newer
	return false
}

// findAssetURL finds the download URL for the current OS/arch from release assets.
func findAssetURL(assets []ghAsset) string {
	goos := runtime.GOOS
	goarch := runtime.GOARCH

	// Map Go arch names to common asset naming patterns
	archAliases := map[string][]string{
		"amd64": {"amd64", "x86_64"},
		"arm64": {"arm64", "aarch64"},
		"386":   {"386", "i386"},
	}

	aliases, ok := archAliases[goarch]
	if !ok {
		aliases = []string{goarch}
	}

	for _, asset := range assets {
		name := strings.ToLower(asset.Name)
		// Skip checksums and signature files
		if strings.HasSuffix(name, ".sha256") || strings.HasSuffix(name, ".sig") {
			continue
		}
		if !strings.Contains(name, goos) {
			continue
		}
		for _, alias := range aliases {
			if strings.Contains(name, alias) {
				return asset.BrowserDownloadURL
			}
		}
	}
	return ""
}

// checkUpdateFromGitHub fetches the latest release info from GitHub.
func checkUpdateFromGitHub() (*UpdateCheckResponse, error) {
	cacheMu.Lock()
	if cachedUpdate != nil && time.Since(cachedUpdateTime) < cacheTTL {
		result := *cachedUpdate
		cacheMu.Unlock()
		return &result, nil
	}
	cacheMu.Unlock()

	req, err := http.NewRequest("GET",
		"https://api.github.com/repos/stefanriegel/UDDI-Token-Calculator/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "uddi-token-calculator/"+version.Version)
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := ghClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
	}

	var release ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, fmt.Errorf("failed to parse GitHub response: %w", err)
	}

	current := version.Version
	result := &UpdateCheckResponse{
		CurrentVersion:  current,
		LatestVersion:   release.TagName,
		UpdateAvailable: false,
		ReleaseURL:      release.HTMLURL,
		ReleaseNotes:    release.Body,
	}

	// Dev builds never show update available
	if current != "dev" {
		result.UpdateAvailable = isNewerVersion(current, release.TagName)
	}

	if result.UpdateAvailable {
		result.DownloadURL = findAssetURL(release.Assets)
	}

	cacheMu.Lock()
	cachedUpdate = result
	cachedUpdateTime = time.Now()
	cacheMu.Unlock()

	return result, nil
}

// HandleCheckUpdate handles GET /api/v1/update/check.
func HandleCheckUpdate(w http.ResponseWriter, r *http.Request) {
	result, err := checkUpdateFromGitHub()
	if err != nil {
		// Return a valid response with current version even on error
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(UpdateCheckResponse{
			CurrentVersion:  version.Version,
			LatestVersion:   version.Version,
			UpdateAvailable: false,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// HandleSelfUpdate handles POST /api/v1/update/apply.
func HandleSelfUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	result, err := checkUpdateFromGitHub()
	if err != nil {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Update check failed: %v", err),
		})
		return
	}

	if !result.UpdateAvailable {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   "Already up to date",
		})
		return
	}

	if result.DownloadURL == "" {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   "No compatible binary found for this platform",
		})
		return
	}

	// Find current executable path
	execPath, err := os.Executable()
	if err != nil {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Cannot determine executable path: %v", err),
		})
		return
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Cannot resolve executable path: %v", err),
		})
		return
	}

	// Detect Homebrew-managed installs — self-update won't have write permission
	if isHomebrewManaged(execPath) {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success:   false,
			ManagedBy: "homebrew",
			Message:   "Run `brew update && brew upgrade uddi-token-calculator` to update.",
		})
		return
	}

	// Check write permission to the executable's directory before downloading
	dir := filepath.Dir(execPath)
	testFile, err := os.CreateTemp(dir, ".uddi-write-test-*")
	if err != nil {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("No write permission to %s. Try running with elevated privileges or use your package manager to update.", dir),
		})
		return
	}
	testFile.Close()
	os.Remove(testFile.Name())

	// Download the new binary to a temp file in the same directory
	// (must be same filesystem for atomic os.Rename)
	tmpFile, err := os.CreateTemp(dir, "uddi-update-*.tmp")
	if err != nil {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Cannot create temp file: %v", err),
		})
		return
	}
	tmpPath := tmpFile.Name()

	// Clean up temp file on any error
	cleanupTmp := func() {
		tmpFile.Close()
		os.Remove(tmpPath)
	}

	dlReq, err := http.NewRequest("GET", result.DownloadURL, nil)
	if err != nil {
		cleanupTmp()
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Invalid download URL: %v", err),
		})
		return
	}
	dlReq.Header.Set("User-Agent", "uddi-token-calculator/"+version.Version)

	dlResp, err := ghClient.Do(dlReq)
	if err != nil {
		cleanupTmp()
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Download failed: %v", err),
		})
		return
	}
	defer dlResp.Body.Close()

	if dlResp.StatusCode != http.StatusOK {
		cleanupTmp()
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Download returned status %d", dlResp.StatusCode),
		})
		return
	}

	if _, err := io.Copy(tmpFile, dlResp.Body); err != nil {
		cleanupTmp()
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to write update: %v", err),
		})
		return
	}
	tmpFile.Close()

	// Make the new binary executable (no-op on Windows)
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpPath, 0755); err != nil {
			os.Remove(tmpPath)
			json.NewEncoder(w).Encode(SelfUpdateResponse{
				Success: false,
				Error:   fmt.Sprintf("Failed to set permissions: %v", err),
			})
			return
		}
	}

	// Rename current to .old, rename new to current
	oldPath := execPath + ".old"
	os.Remove(oldPath) // remove any previous .old file

	if err := os.Rename(execPath, oldPath); err != nil {
		os.Remove(tmpPath)
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to backup current binary: %v", err),
		})
		return
	}

	if err := os.Rename(tmpPath, execPath); err != nil {
		// Try to restore the old binary
		os.Rename(oldPath, execPath)
		os.Remove(tmpPath)
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to install update: %v", err),
		})
		return
	}

	// Invalidate cache so next check picks up new version
	cacheMu.Lock()
	cachedUpdate = nil
	cacheMu.Unlock()

	json.NewEncoder(w).Encode(SelfUpdateResponse{
		Success:        true,
		Message:        fmt.Sprintf("Updated to %s. Press 'Restart Now' to apply.", result.LatestVersion),
		RestartPending: true,
	})
}

// isHomebrewManaged returns true if the executable path is inside a Homebrew Cellar.
func isHomebrewManaged(execPath string) bool {
	// Homebrew symlinks: /opt/homebrew/bin/x -> ../Cellar/x/version/bin/x
	// or: /usr/local/bin/x -> ../Cellar/x/version/bin/x
	return strings.Contains(execPath, "/Cellar/")
}

// HandleRestart handles POST /api/v1/update/restart.
// It sends a success response, then re-execs the process after a short delay
// so the new binary takes effect without manual restart.
func HandleRestart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	execPath, err := os.Executable()
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"success": false,
			"error":   fmt.Sprintf("Cannot determine executable path: %v", err),
		})
		return
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Restarting...",
	})

	// Flush the response before exiting
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	// Give the HTTP response time to reach the client, then re-exec
	go func() {
		time.Sleep(500 * time.Millisecond)

		// Re-exec the current binary with the same arguments.
		// Since HandleSelfUpdate already replaced the binary on disk,
		// this launches the new version.
		if err := syscall.Exec(execPath, os.Args, os.Environ()); err != nil {
			// Exec replaces the process — if we get here it failed.
			// Fall back to a clean exit so the user can relaunch manually.
			log.Printf("restart exec failed: %v — exiting so user can relaunch", err)
			os.Exit(0)
		}
	}()
}
