// cmd/verify-vnios-specs/main.go — VNIOS_SPECS drift detector.
//
// Verifies that the Go-side `internal/calculator.VNIOSSpecs` table and the
// TS-side `frontend/src/app/components/resource-savings.ts` `VNIOS_SPECS` table
// produce byte-identical canonical JSON, that both compute the same SHA256 hex
// digest, and that both match the committed `internal/calculator/vnios_specs.sha256`
// file.
//
// On any drift the binary prints a header, identifies which pair mismatched,
// emits a side-by-side row diff (when the JSON arrays differ), and exits with
// a non-zero status. On success it prints "OK — VNIOS_SPECS Go ↔ TS parity
// verified" and exits 0.
//
// Invoked via `make verify-vnios-specs` and from CI (.gitlab-ci.yml,
// .github/workflows/release.yml).
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
)

const hashFileRel = "internal/calculator/vnios_specs.sha256"

func main() {
	repoRoot, err := findRepoRoot()
	if err != nil {
		failf("locate repo root: %v", err)
	}

	// 1. Go-side canonical JSON + hash.
	goJSON := []byte(calculator.CanonicalVNIOSSpecsJSON())
	goHash := calculator.ComputeVNIOSSpecsHash()

	// 2. TS-side canonical JSON + hash via `npx tsx frontend/scripts/print-vnios-hash.ts`.
	tsJSON, err := runTSPrint(repoRoot, "json")
	if err != nil {
		failf("invoke TS print-vnios-hash (json): %v", err)
	}
	tsHashRaw, err := runTSPrint(repoRoot, "hash")
	if err != nil {
		failf("invoke TS print-vnios-hash (hash): %v", err)
	}
	tsHash := strings.TrimSpace(string(tsHashRaw))

	// 3. Committed hash file.
	hashFilePath := filepath.Join(repoRoot, hashFileRel)
	rawFileHash, err := os.ReadFile(hashFilePath)
	if err != nil {
		failf("read %s: %v", hashFilePath, err)
	}
	fileHash := strings.TrimSpace(string(rawFileHash))

	// 4. Compare all three hashes + raw JSON bytes.
	mismatch := false
	var report bytes.Buffer

	if goHash != tsHash {
		mismatch = true
		fmt.Fprintf(&report, "  Go hash:  %s\n", goHash)
		fmt.Fprintf(&report, "  TS hash:  %s\n", tsHash)
		fmt.Fprintf(&report, "  → Go ↔ TS hash mismatch\n\n")
	}
	if fileHash != goHash {
		mismatch = true
		fmt.Fprintf(&report, "  File hash: %s (%s)\n", fileHash, hashFileRel)
		fmt.Fprintf(&report, "  Go hash:   %s\n", goHash)
		fmt.Fprintf(&report, "  → committed hash ↔ Go mismatch\n\n")
	}
	if fileHash != tsHash {
		mismatch = true
		fmt.Fprintf(&report, "  File hash: %s (%s)\n", fileHash, hashFileRel)
		fmt.Fprintf(&report, "  TS hash:   %s\n", tsHash)
		fmt.Fprintf(&report, "  → committed hash ↔ TS mismatch\n\n")
	}
	if !bytes.Equal(goJSON, tsJSON) {
		mismatch = true
		fmt.Fprintf(&report, "  Canonical JSON byte mismatch (Go=%d bytes, TS=%d bytes)\n",
			len(goJSON), len(tsJSON))
		writeRowDiff(&report, goJSON, tsJSON)
	}

	if mismatch {
		fmt.Fprintln(os.Stderr, "VNIOS_SPECS DRIFT DETECTED")
		fmt.Fprintln(os.Stderr, strings.Repeat("─", 60))
		fmt.Fprint(os.Stderr, report.String())
		fmt.Fprintln(os.Stderr, strings.Repeat("─", 60))
		fmt.Fprintln(os.Stderr, "Resolve by aligning the divergent row in either")
		fmt.Fprintln(os.Stderr, "  internal/calculator/vnios_specs.go  (Go side)")
		fmt.Fprintln(os.Stderr, "  frontend/src/app/components/resource-savings.ts  (TS side)")
		fmt.Fprintln(os.Stderr, "then update internal/calculator/vnios_specs.sha256 with the new agreed hash.")
		os.Exit(1)
	}

	rowCount := countRows(goJSON)
	fmt.Printf("OK — VNIOS_SPECS Go ↔ TS parity verified (hash %s, %d rows)\n", goHash, rowCount)
}

// runTSPrint shells out to `npx --no-install tsx frontend/scripts/print-vnios-hash.ts <mode>`
// from repoRoot, returning stdout. Falls back to `npx tsx ...` (auto-fetch) if
// the local install isn't present.
func runTSPrint(repoRoot, mode string) ([]byte, error) {
	scriptRel := filepath.Join("frontend", "scripts", "print-vnios-hash.ts")

	// Try local first to avoid network if tsx is already cached.
	cmd := exec.Command("npx", "--no-install", "tsx", scriptRel, mode)
	cmd.Dir = repoRoot
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err == nil {
		return out, nil
	}

	// Fall back to auto-fetching tsx.
	cmd = exec.Command("npx", "--yes", "tsx", scriptRel, mode)
	cmd.Dir = repoRoot
	cmd.Stderr = os.Stderr
	return cmd.Output()
}

// writeRowDiff parses both canonical JSON arrays into []map[string]interface{}
// and walks them in lockstep, printing the first divergent row pair.
func writeRowDiff(w *bytes.Buffer, goJSON, tsJSON []byte) {
	var goRows, tsRows []map[string]interface{}
	if err := json.Unmarshal(goJSON, &goRows); err != nil {
		fmt.Fprintf(w, "  (could not parse Go JSON for diff: %v)\n", err)
		return
	}
	if err := json.Unmarshal(tsJSON, &tsRows); err != nil {
		fmt.Fprintf(w, "  (could not parse TS JSON for diff: %v)\n", err)
		return
	}

	maxLen := len(goRows)
	if len(tsRows) > maxLen {
		maxLen = len(tsRows)
	}

	diffsShown := 0
	const maxDiffs = 5

	for i := 0; i < maxLen && diffsShown < maxDiffs; i++ {
		var goRow, tsRow map[string]interface{}
		if i < len(goRows) {
			goRow = goRows[i]
		}
		if i < len(tsRows) {
			tsRow = tsRows[i]
		}
		goLine, _ := json.Marshal(goRow)
		tsLine, _ := json.Marshal(tsRow)
		if !bytes.Equal(goLine, tsLine) {
			fmt.Fprintf(w, "  row[%d]:\n", i)
			fmt.Fprintf(w, "    Go: %s\n", string(goLine))
			fmt.Fprintf(w, "    TS: %s\n", string(tsLine))
			diffsShown++
		}
	}
	if diffsShown == 0 {
		fmt.Fprintf(w, "  (rows parsed equal but raw bytes differ — likely whitespace or key order)\n")
	} else if diffsShown == maxDiffs {
		fmt.Fprintf(w, "  (showing first %d divergent rows; more may follow)\n", maxDiffs)
	}
}

// countRows parses the canonical JSON and returns the number of top-level rows.
func countRows(jsonBytes []byte) int {
	var rows []json.RawMessage
	if err := json.Unmarshal(jsonBytes, &rows); err != nil {
		return -1
	}
	return len(rows)
}

// findRepoRoot walks up from cwd until it finds a directory containing go.mod.
func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.mod not found above %s", dir)
		}
		dir = parent
	}
}

func failf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "verify-vnios-specs: "+format+"\n", args...)
	os.Exit(2)
}
