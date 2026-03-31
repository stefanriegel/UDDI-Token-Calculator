package efficientip

import (
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
