package efficientip

import (
	"archive/tar"
	"bytes"
	"encoding/binary"

	"github.com/klauspost/compress/zstd"
)

// tableSpec describes one TABLE DATA entry for buildMinimalPgDump.
type tableSpec struct {
	Name     string
	DataPos  int64
}

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

// ---------------------------------------------------------------------------
// pg_dump binary builder — test helper
// ---------------------------------------------------------------------------

// pgDumpWriter wraps a bytes.Buffer with helpers that emit pg_dump wire-format
// integers, strings, and offsets.  It uses intSize=4, offSize=8 throughout,
// which matches the buildMinimalPgDump defaults.
type pgDumpWriter struct {
	b       bytes.Buffer
	intSize int
	offSize int
}

// writeInt emits the pg_dump sign+value integer encoding.
func (w *pgDumpWriter) writeInt(v int64) {
	sign := byte(0)
	if v < 0 {
		sign = 1
		v = -v
	}
	w.b.WriteByte(sign)
	buf := make([]byte, w.intSize)
	binary.LittleEndian.PutUint32(buf, uint32(v)) // intSize==4
	w.b.Write(buf)
}

// writeStr emits a length-prefixed string (or the NULL sentinel when s == "").
func (w *pgDumpWriter) writeStr(s string) {
	if s == "" {
		// NULL sentinel: sign=0 + 4 bytes of zero
		w.writeInt(0)
		return
	}
	w.writeInt(int64(len(s)))
	w.b.WriteString(s)
}

// writeOffset emits a pg_dump offset field.
// When set==true, emits kOffsetPosSet flag + 8-byte little-endian value.
// Otherwise emits kOffsetPosNotSet flag byte only (no value bytes).
func (w *pgDumpWriter) writeOffset(val int64, set bool) {
	if !set {
		w.b.WriteByte(kOffsetPosNotSet)
		return
	}
	w.b.WriteByte(kOffsetPosSet)
	buf := make([]byte, w.offSize)
	binary.LittleEndian.PutUint64(buf, uint64(val))
	w.b.Write(buf)
}

// buildMinimalPgDump produces a valid pg_dump custom-format binary in memory.
// Header: magic PGDMP, version {1,16,0}, intSize=4, offSize=8, format=3,
// compressionAlgo=0 (none).
// One TABLE DATA TOC entry is emitted per element of tables.
// No other TOC entries are produced; the result is minimal but fully parseable.
func buildMinimalPgDump(tables []tableSpec) []byte {
	w := &pgDumpWriter{intSize: 4, offSize: 8}
	b := &w.b

	// magic
	b.WriteString(pgDumpMagic) // "PGDMP"
	// vmaj, vmin, vrev, intSize, offSize, format
	b.Write([]byte{1, 16, 0, 4, 8, 3})

	// compressionAlgo (version >= 1.15)
	w.writeInt(0) // 0 = no compression

	// crtm (time_t as int)
	w.writeInt(0)
	// dbname, remoteVersion, pgdumpVersion
	w.writeStr("testdb")
	w.writeStr("160001")
	w.writeStr("pg_dump (PostgreSQL) 16.1")

	// tablespace map (version >= 1.10): empty
	w.writeInt(0)

	// TOC entry count
	w.writeInt(int64(len(tables)))

	for i, ts := range tables {
		// dumpId
		w.writeInt(int64(i + 1))
		// hadDumper = 1
		w.writeInt(1)
		// tableoid (>= 1.3)
		w.writeStr("16400")
		// oid
		w.writeStr("16400")
		// tag — the table name
		w.writeStr(ts.Name)
		// desc
		w.writeStr("TABLE DATA")
		// section (>= 1.11): SECTION_DATA = 2
		w.writeInt(2)
		// defn, dropStmt
		w.writeStr("")
		w.writeStr("")
		// copyStmt
		w.writeStr("COPY public." + ts.Name + " FROM stdin;")
		// namespace
		w.writeStr("public")
		// tablespace (>= 1.10)
		w.writeStr("")
		// tableam (>= 1.14)
		w.writeStr("heap")
		// relkind (>= 1.16)
		w.writeStr("r")
		// owner
		w.writeStr("postgres")
		// dependencies: NULL sentinel only
		w.writeStr("")
		// dataLength (>= 1.8): not set
		w.writeOffset(0, false)
		// dataPos (>= 1.1)
		w.writeOffset(ts.DataPos, true)
	}

	return b.Bytes()
}
