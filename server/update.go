package server

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
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
	TagName    string    `json:"tag_name"`
	HTMLURL    string    `json:"html_url"`
	Body       string    `json:"body"`
	Prerelease bool      `json:"prerelease"`
	Assets     []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// ghClient is the HTTP client used for GitHub API calls (short timeout).
var ghClient = &http.Client{Timeout: 30 * time.Second}

// dlClient is the HTTP client used for binary downloads (no timeout — relies on
// the OS TCP keepalive and io.Copy progress; a fixed timeout would kill large downloads).
var dlClient = &http.Client{Timeout: 0}

// ghReleasesURL is the base URL for GitHub Releases API calls.
// It is a var (not const) so tests can override it with httptest.NewServer URLs.
var ghReleasesURL = "https://api.github.com/repos/stefanriegel/UDDI-Token-Calculator/releases"

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
	// Both pre-release with same major.minor.patch — compare dev.N numerically
	if cPre != "" && lPre != "" {
		if strings.HasPrefix(cPre, "dev.") && strings.HasPrefix(lPre, "dev.") {
			cNum, cErr := strconv.Atoi(strings.TrimPrefix(cPre, "dev."))
			lNum, lErr := strconv.Atoi(strings.TrimPrefix(lPre, "dev."))
			if cErr == nil && lErr == nil {
				return lNum > cNum
			}
		}
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
// For stable channel: fetches /releases/latest (single release).
// For dev channel: fetches /releases?per_page=20 and selects the highest-versioned pre-release.
func checkUpdateFromGitHub() (*UpdateCheckResponse, error) {
	cacheMu.Lock()
	if cachedUpdate != nil && time.Since(cachedUpdateTime) < cacheTTL {
		result := *cachedUpdate
		cacheMu.Unlock()
		return &result, nil
	}
	cacheMu.Unlock()

	current := version.Version

	var release *ghRelease

	if version.Channel == "dev" {
		// Dev channel: list recent releases and pick the first pre-release
		url := ghReleasesURL + "?per_page=20"
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "uddi-token-calculator/"+current)
		req.Header.Set("Accept", "application/vnd.github+json")

		resp, err := ghClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("GitHub API request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
		}

		var releases []ghRelease
		if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
			return nil, fmt.Errorf("failed to parse GitHub response: %w", err)
		}

		// GitHub's list order is not guaranteed to be semver-sorted,
		// so collect all pre-releases and pick the highest version.
		for i := range releases {
			if !releases[i].Prerelease {
				continue
			}
			if release == nil || isNewerVersion(release.TagName, releases[i].TagName) {
				r := releases[i]
				release = &r
			}
		}

		if release == nil {
			// No pre-releases found — return no update available
			result := &UpdateCheckResponse{
				CurrentVersion:  current,
				LatestVersion:   current,
				UpdateAvailable: false,
			}
			cacheMu.Lock()
			cachedUpdate = result
			cachedUpdateTime = time.Now()
			cacheMu.Unlock()
			return result, nil
		}
	} else {
		// Stable channel: fetch the single latest release
		url := ghReleasesURL + "/latest"
		req, err := http.NewRequest("GET", url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "uddi-token-calculator/"+current)
		req.Header.Set("Accept", "application/vnd.github+json")

		resp, err := ghClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("GitHub API request failed: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
		}

		var r ghRelease
		if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
			return nil, fmt.Errorf("failed to parse GitHub response: %w", err)
		}
		release = &r
	}

	result := &UpdateCheckResponse{
		CurrentVersion:  current,
		LatestVersion:   release.TagName,
		UpdateAvailable: false,
		ReleaseURL:      release.HTMLURL,
		ReleaseNotes:    release.Body,
	}

	result.UpdateAvailable = isNewerVersion(current, release.TagName)

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
			DockerMode:      isDocker(),
		})
		return
	}

	result.DockerMode = isDocker()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// HandleSelfUpdate handles POST /api/v1/update/apply.
func HandleSelfUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if isDocker() {
		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success:   false,
			Error:     "Auto-update is not available in Docker. Pull the latest image: docker compose pull && docker compose up -d",
			ManagedBy: "docker",
		})
		return
	}

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

	// Detect Homebrew-managed installs — use brew upgrade instead of direct binary replacement
	if isHomebrewManaged(execPath) {
		if err := brewUpgrade(); err != nil {
			json.NewEncoder(w).Encode(SelfUpdateResponse{
				Success: false,
				Error:   fmt.Sprintf("Homebrew upgrade failed: %v", err),
			})
			return
		}

		// Invalidate cache so next check picks up new version
		cacheMu.Lock()
		cachedUpdate = nil
		cacheMu.Unlock()

		json.NewEncoder(w).Encode(SelfUpdateResponse{
			Success:        true,
			Message:        fmt.Sprintf("Updated to %s via Homebrew. Press 'Restart Now' to apply.", result.LatestVersion),
			RestartPending: true,
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

	dlResp, err := dlClient.Do(dlReq)
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

// isDocker returns true when the process is running inside a Docker container.
func isDocker() bool {
	// Standard Docker marker file
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	return false
}

// isHomebrewManaged returns true if the executable path is inside a Homebrew Cellar.
func isHomebrewManaged(execPath string) bool {
	// Homebrew symlinks: /opt/homebrew/bin/x -> ../Cellar/x/version/bin/x
	// or: /usr/local/bin/x -> ../Cellar/x/version/bin/x
	return strings.Contains(execPath, "/Cellar/")
}

// brewUpgrade runs `brew update && brew upgrade uddi-token-calculator`.
// Returns an error if brew is not found or the upgrade fails.
func brewUpgrade() error {
	brewPath, err := exec.LookPath("brew")
	if err != nil {
		return fmt.Errorf("brew not found in PATH: %w", err)
	}

	// brew update (refresh tap)
	updateCmd := exec.Command(brewPath, "update")
	updateCmd.Stdout = io.Discard
	updateCmd.Stderr = io.Discard
	if err := updateCmd.Run(); err != nil {
		return fmt.Errorf("brew update failed: %w", err)
	}

	// brew upgrade uddi-token-calculator
	upgradeCmd := exec.Command(brewPath, "upgrade", "uddi-token-calculator")
	out, err := upgradeCmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("brew upgrade failed: %s — %w", strings.TrimSpace(string(out)), err)
	}

	return nil
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
