package efficientip

import (
	"context"
	"os"
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

func TestBackupScanner_MissingPath(t *testing.T) {
	bs := NewBackup()
	req := scanner.ScanRequest{
		Provider:    "efficientip",
		Credentials: map[string]string{},
	}
	_, err := bs.Scan(context.Background(), req, func(scanner.Event) {})
	if err == nil {
		t.Fatal("expected error for missing backup_path, got nil")
	}
}

func TestBackupScanner_CallsScanBackup(t *testing.T) {
	data, err := buildFullBackupFile()
	if err != nil {
		t.Fatalf("buildFullBackupFile: %v", err)
	}

	tmp, err := os.CreateTemp("", "efficientip-test-*.gz")
	if err != nil {
		t.Fatalf("create temp: %v", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		t.Fatalf("write temp: %v", err)
	}
	tmp.Close()
	// NOTE: do not defer Remove here -- BackupScanner.Scan removes the file via defer os.Remove.

	bs := NewBackup()
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"backup_path": tmp.Name(),
		},
	}

	rows, err := bs.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan returned error: %v", err)
	}
	if len(rows) != 13 {
		t.Fatalf("expected 13 FindingRows, got %d", len(rows))
	}
	for _, row := range rows {
		if row.Source != "backup" {
			t.Errorf("expected Source=backup, got %q for item %q", row.Source, row.Item)
		}
	}

	// Verify the temp file was removed by BackupScanner.
	if _, statErr := os.Stat(tmp.Name()); !os.IsNotExist(statErr) {
		os.Remove(tmp.Name()) // clean up if scanner failed to remove
		t.Error("expected BackupScanner to remove the temp file after scanning")
	}
}
