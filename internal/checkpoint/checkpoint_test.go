package checkpoint_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/checkpoint"
)

func TestCheckpoint_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test-checkpoint.json")

	cp := checkpoint.New(path, "scan-123", "aws")

	unit := checkpoint.CompletedUnit{
		ID:          "acct-1",
		Name:        "prod-account",
		CompletedAt: time.Now(),
		Findings: []calculator.FindingRow{
			{Provider: "aws", Source: "acct-1", Category: calculator.CategoryDDIObjects, Item: "vpc", Count: 5, TokensPerUnit: 25, ManagementTokens: 1},
			{Provider: "aws", Source: "acct-1", Category: calculator.CategoryActiveIPs, Item: "eni", Count: 26, TokensPerUnit: 13, ManagementTokens: 2},
		},
	}

	if err := cp.AddUnit(unit); err != nil {
		t.Fatalf("AddUnit: %v", err)
	}

	state, err := checkpoint.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if state == nil {
		t.Fatal("Load returned nil state for existing file")
	}

	if state.Version != 1 {
		t.Errorf("Version = %d, want 1", state.Version)
	}
	if state.ScanID != "scan-123" {
		t.Errorf("ScanID = %q, want %q", state.ScanID, "scan-123")
	}
	if state.Provider != "aws" {
		t.Errorf("Provider = %q, want %q", state.Provider, "aws")
	}
	if len(state.CompletedUnits) != 1 {
		t.Fatalf("CompletedUnits count = %d, want 1", len(state.CompletedUnits))
	}

	got := state.CompletedUnits[0]
	if got.ID != "acct-1" {
		t.Errorf("unit ID = %q, want %q", got.ID, "acct-1")
	}
	if got.Name != "prod-account" {
		t.Errorf("unit Name = %q, want %q", got.Name, "prod-account")
	}
	if len(got.Findings) != 2 {
		t.Fatalf("Findings count = %d, want 2", len(got.Findings))
	}
	if got.Findings[0].Count != 5 {
		t.Errorf("Findings[0].Count = %d, want 5", got.Findings[0].Count)
	}
	if got.Findings[1].Count != 26 {
		t.Errorf("Findings[1].Count = %d, want 26", got.Findings[1].Count)
	}
}

func TestLoad_FileNotExist(t *testing.T) {
	state, err := checkpoint.Load(filepath.Join(t.TempDir(), "nonexistent.json"))
	if err != nil {
		t.Fatalf("Load on non-existent file should return nil error, got: %v", err)
	}
	if state != nil {
		t.Fatalf("Load on non-existent file should return nil state, got: %+v", state)
	}
}

func TestLoad_VersionMismatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad-version.json")

	badState := map[string]interface{}{
		"version":         99,
		"scan_id":         "scan-old",
		"provider":        "aws",
		"created_at":      time.Now(),
		"completed_units": []interface{}{},
	}
	data, err := json.Marshal(badState)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	state, err := checkpoint.Load(path)
	if err == nil {
		t.Fatal("Load should return error for version mismatch")
	}
	if state != nil {
		t.Fatalf("Load should return nil state on version mismatch, got: %+v", state)
	}
	if !strings.Contains(err.Error(), "not supported") {
		t.Errorf("error should contain 'not supported', got: %v", err)
	}
}

func TestCheckpoint_ConcurrentAddUnit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "concurrent.json")

	cp := checkpoint.New(path, "scan-concurrent", "gcp")

	const n = 10
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(idx int) {
			defer wg.Done()
			unit := checkpoint.CompletedUnit{
				ID:          fmt.Sprintf("proj-%d", idx),
				Name:        fmt.Sprintf("project-%d", idx),
				CompletedAt: time.Now(),
				Findings: []calculator.FindingRow{
					{Provider: "gcp", Source: fmt.Sprintf("proj-%d", idx), Category: calculator.CategoryDDIObjects, Item: "network", Count: 1},
				},
			}
			if err := cp.AddUnit(unit); err != nil {
				t.Errorf("AddUnit goroutine %d: %v", idx, err)
			}
		}(i)
	}
	wg.Wait()

	state, err := checkpoint.Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if state == nil {
		t.Fatal("Load returned nil")
	}
	if len(state.CompletedUnits) != n {
		t.Errorf("CompletedUnits = %d, want %d", len(state.CompletedUnits), n)
	}

	// Verify no duplicates.
	seen := make(map[string]bool)
	for _, u := range state.CompletedUnits {
		if seen[u.ID] {
			t.Errorf("duplicate unit ID: %s", u.ID)
		}
		seen[u.ID] = true
	}
}

func TestDelete(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "delete-test.json")

	cp := checkpoint.New(path, "scan-del", "azure")
	if err := cp.AddUnit(checkpoint.CompletedUnit{ID: "sub-1", Name: "sub-one", CompletedAt: time.Now()}); err != nil {
		t.Fatalf("AddUnit: %v", err)
	}

	// File should exist.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file should exist after AddUnit: %v", err)
	}

	if err := checkpoint.Delete(path); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	// File should be gone.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file should not exist after Delete, stat err: %v", err)
	}

	// Second delete should be idempotent.
	if err := checkpoint.Delete(path); err != nil {
		t.Fatalf("second Delete should return nil, got: %v", err)
	}
}

func TestAutoPath(t *testing.T) {
	path := checkpoint.AutoPath("scan-abc", "aws")

	if !strings.Contains(path, os.TempDir()) {
		t.Errorf("AutoPath should contain os.TempDir(), got: %s", path)
	}
	if !strings.Contains(path, "aws") {
		t.Errorf("AutoPath should contain provider name, got: %s", path)
	}
	if !strings.Contains(path, "scan-abc") {
		t.Errorf("AutoPath should contain scanID, got: %s", path)
	}
	if !strings.HasSuffix(path, ".json") {
		t.Errorf("AutoPath should end with .json, got: %s", path)
	}
}
