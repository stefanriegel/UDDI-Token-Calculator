package efficientip

import (
	"context"
	"fmt"
	"os"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// BackupScanner implements scanner.Scanner for EfficientIP SOLIDserver backup files.
// It reads the backup file path from req.Credentials["backup_path"] and delegates
// to ScanBackup for parsing and row counting.
type BackupScanner struct{}

// NewBackup returns a new BackupScanner.
func NewBackup() *BackupScanner { return &BackupScanner{} }

// Scan executes the backup scan. It expects req.Credentials["backup_path"] to be set
// to the temp file path written by HandleUploadEfficientipBackup.
// The temp file is removed after scanning via defer.
func (b *BackupScanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	path, ok := req.Credentials["backup_path"]
	if !ok || path == "" {
		return nil, fmt.Errorf("efficientip backup: backup_path credential is required")
	}

	defer os.Remove(path)

	return ScanBackup(ctx, path, publish)
}
