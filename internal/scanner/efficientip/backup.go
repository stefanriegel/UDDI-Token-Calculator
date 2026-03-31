package efficientip

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"os"

	"github.com/klauspost/compress/zstd"
)

// openBackupFile opens a zstd-compressed tar archive at path, locates the
// "db.psql" entry, reads it fully into memory, and returns a *bytes.Reader
// (which implements io.ReadSeeker). The caller must invoke the returned cleanup
// function to release the underlying file handle.
func openBackupFile(path string) (io.ReadSeeker, func(), error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, fmt.Errorf("openBackupFile: open %q: %w", path, err)
	}
	cleanup := func() { f.Close() }

	zr, err := zstd.NewReader(f)
	if err != nil {
		cleanup()
		return nil, nil, fmt.Errorf("openBackupFile: create zstd reader: %w", err)
	}

	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			zr.Close()
			cleanup()
			return nil, nil, fmt.Errorf("openBackupFile: read tar: %w", err)
		}
		if hdr.Name == "db.psql" {
			var buf bytes.Buffer
			if _, err := io.Copy(&buf, tr); err != nil {
				zr.Close()
				cleanup()
				return nil, nil, fmt.Errorf("openBackupFile: read db.psql: %w", err)
			}
			zr.Close()
			return bytes.NewReader(buf.Bytes()), cleanup, nil
		}
	}

	zr.Close()
	cleanup()
	return nil, nil, fmt.Errorf("openBackupFile: db.psql not found in %q", path)
}
