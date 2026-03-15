// Package checkpoint provides atomic persistence for scan progress so that
// interrupted multi-unit scans can resume without re-scanning completed units.
//
// A Checkpoint accumulates CompletedUnit records in memory. After each unit
// completes, AddUnit appends the record and atomically writes the entire state
// to disk (write-tmp + rename). On resume, Load reads the file back and returns
// the full CheckpointState so the scanner can build a skip-set and prepend
// previously discovered findings.
package checkpoint

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
)

// Version is the forward-compatibility guard. Load rejects files with a
// different version so that future format changes fail fast instead of
// silently corrupting data.
const Version = 1

// CompletedUnit records one finished scan unit (account / subscription / project).
type CompletedUnit struct {
	ID          string                  `json:"id"`
	Name        string                  `json:"name"`
	CompletedAt time.Time               `json:"completed_at"`
	Findings    []calculator.FindingRow  `json:"findings"`
}

// CheckpointState is the on-disk representation of scan progress.
type CheckpointState struct {
	Version        int             `json:"version"`
	ScanID         string          `json:"scan_id"`
	Provider       string          `json:"provider"`
	CreatedAt      time.Time       `json:"created_at"`
	CompletedUnits []CompletedUnit `json:"completed_units"`
}

// Checkpoint is an in-memory accumulator that persists state atomically after
// every AddUnit call. All public methods are safe for concurrent use.
type Checkpoint struct {
	path  string
	mu    sync.Mutex
	state CheckpointState
}

// New creates a Checkpoint that will persist to path. The initial state has an
// empty CompletedUnits slice.
func New(path, scanID, provider string) *Checkpoint {
	return &Checkpoint{
		path: path,
		state: CheckpointState{
			Version:        Version,
			ScanID:         scanID,
			Provider:       provider,
			CreatedAt:      time.Now(),
			CompletedUnits: []CompletedUnit{},
		},
	}
}

// AddUnit appends a completed unit and atomically persists the updated state.
// It is safe for concurrent use.
func (c *Checkpoint) AddUnit(unit CompletedUnit) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.state.CompletedUnits = append(c.state.CompletedUnits, unit)
	return atomicSave(c.path, c.state)
}

// atomicSave marshals state to JSON, writes to a temporary file, then renames
// atomically so readers never see a partial write.
func atomicSave(path string, state CheckpointState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("checkpoint marshal: %w", err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("checkpoint write tmp: %w", err)
	}

	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("checkpoint rename: %w", err)
	}
	return nil
}

// Load reads a checkpoint file and returns the deserialized state.
// Returns (nil, nil) if the file does not exist — the caller should treat this
// as a fresh scan. Returns an error if the file exists but has an incompatible
// version.
func Load(path string) (*CheckpointState, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("checkpoint read: %w", err)
	}

	var state CheckpointState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("checkpoint unmarshal: %w", err)
	}

	if state.Version != Version {
		return nil, fmt.Errorf("checkpoint version %d not supported (expected %d)", state.Version, Version)
	}
	return &state, nil
}

// Delete removes a checkpoint file. It is safe to call on a non-existent path
// (returns nil for idempotency).
func Delete(path string) error {
	err := os.Remove(path)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("checkpoint delete: %w", err)
	}
	return nil
}

// AutoPath returns a deterministic checkpoint file path in the OS temp
// directory for the given provider and scan ID.
func AutoPath(scanID, provider string) string {
	return filepath.Join(os.TempDir(), fmt.Sprintf("checkpoint-%s-%s.json", provider, scanID))
}
