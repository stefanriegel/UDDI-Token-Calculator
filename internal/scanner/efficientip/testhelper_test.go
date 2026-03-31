package efficientip

import (
	"archive/tar"
	"bytes"

	"github.com/klauspost/compress/zstd"
)

// buildMinimalZstdTar creates a zstd-compressed tar archive in memory that
// contains a single entry named "db.psql" with the provided content.
// It is intended for use in unit tests only.
func buildMinimalZstdTar(dbPsqlContent []byte) ([]byte, error) {
	var buf bytes.Buffer

	zw, err := zstd.NewWriter(&buf)
	if err != nil {
		return nil, err
	}

	tw := tar.NewWriter(zw)
	hdr := &tar.Header{
		Name: "db.psql",
		Mode: 0600,
		Size: int64(len(dbPsqlContent)),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return nil, err
	}
	if _, err := tw.Write(dbPsqlContent); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}
