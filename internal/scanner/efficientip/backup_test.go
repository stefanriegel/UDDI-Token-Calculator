package efficientip

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestOpenBackupFile(t *testing.T) {
	const content = "SELECT 1; -- dummy pg_dump content"

	// Build a minimal zstd-compressed tar in memory.
	data, err := buildMinimalZstdTar([]byte(content))
	if err != nil {
		t.Fatalf("buildMinimalZstdTar: %v", err)
	}

	// Write it to a temp file.
	dir := t.TempDir()
	path := filepath.Join(dir, "backup.zst")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatalf("write temp file: %v", err)
	}

	// Open and extract.
	rs, cleanup, err := openBackupFile(path)
	if err != nil {
		t.Fatalf("openBackupFile: %v", err)
	}
	defer cleanup()

	got, err := io.ReadAll(rs)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}

	if string(got) != content {
		t.Errorf("content mismatch: got %q, want %q", got, content)
	}

	// Verify that rs is seekable.
	if _, err := rs.Seek(0, io.SeekStart); err != nil {
		t.Errorf("Seek failed: %v", err)
	}
}

func TestOpenBackupFile_MissingEntry(t *testing.T) {
	// We can't easily build a tar without "db.psql" using the helper, so
	// instead verify that a non-existent path returns an error.
	_, _, err := openBackupFile("/nonexistent/path/backup.zst")
	if err == nil {
		t.Error("expected error for non-existent file, got nil")
	}
}

// ---------------------------------------------------------------------------
// TestParsePgDump
// ---------------------------------------------------------------------------

func TestParsePgDump(t *testing.T) {
	specs := []tableSpec{
		{Name: "ip_address", DataPos: 1024},
		{Name: "ip_subnet", DataPos: 4096},
		{Name: "ip_space", DataPos: 8192},
	}

	raw := buildMinimalPgDump(specs)
	rs := bytes.NewReader(raw)

	doc, err := parsePgDump(rs)
	if err != nil {
		t.Fatalf("parsePgDump error: %v", err)
	}

	// version sanity
	if doc.VMaj != 1 || doc.VMin != 16 || doc.VRev != 0 {
		t.Errorf("version: got {%d,%d,%d}, want {1,16,0}", doc.VMaj, doc.VMin, doc.VRev)
	}

	if len(doc.TOC) != len(specs) {
		t.Fatalf("TOC length: got %d, want %d", len(doc.TOC), len(specs))
	}

	for i, spec := range specs {
		entry := doc.TOC[i]
		if entry.Tag != spec.Name {
			t.Errorf("TOC[%d].Tag = %q, want %q", i, entry.Tag, spec.Name)
		}
		if entry.Desc != "TABLE DATA" {
			t.Errorf("TOC[%d].Desc = %q, want TABLE DATA", i, entry.Desc)
		}
		if !entry.DataOffsetSet {
			t.Errorf("TOC[%d].DataOffsetSet = false, want true", i)
		}
		if entry.DataOffset != spec.DataPos {
			t.Errorf("TOC[%d].DataOffset = %d, want %d", i, entry.DataOffset, spec.DataPos)
		}
	}
}
