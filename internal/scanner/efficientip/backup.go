package efficientip

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"os"

	"github.com/klauspost/compress/zstd"
)

// ---------------------------------------------------------------------------
// pg_dump custom-format types
// ---------------------------------------------------------------------------

// pgDumpDoc holds the parsed contents of a pg_dump custom-format archive.
type pgDumpDoc struct {
	VMaj      uint8
	VMin      uint8
	VRev      uint8
	IntSize   uint8
	OffSize   uint8
	Format    uint8
	ComprAlgo int32
	TOC       []tocEntry
}

// tocEntry represents a single entry in the pg_dump table-of-contents.
type tocEntry struct {
	DumpID        int32
	Tag           string // object name (table name for TABLE DATA entries)
	Desc          string // object type ("TABLE DATA", "TABLE", etc.)
	Section       int32  // SECTION_PRE_DATA=1 SECTION_DATA=2 SECTION_POST_DATA=3
	CopyStmt      string // COPY statement used to restore row data
	DataOffset    int64  // byte offset of the data block in the archive
	DataOffsetSet bool   // true when DataOffset is a valid position
	ComprAlgo     int32  // compression algorithm (inherited from doc header)
}

// ---------------------------------------------------------------------------
// pg_dump binary format constants
// ---------------------------------------------------------------------------

const (
	pgDumpMagic        = "PGDMP"
	kOffsetPosNotSet   = 1
	kOffsetNoData      = 2
	kOffsetPosSet      = 4
)

// pgDumpVer converts {major, minor, rev} into a comparable integer, matching
// the K_VERS_* constants used in the PostgreSQL source (pg_backup_archiver.c).
func pgDumpVer(maj, min, rev int) int {
	return (maj*256+min)*256 + rev
}

// ---------------------------------------------------------------------------
// Low-level binary readers (pg_dump wire format)
// ---------------------------------------------------------------------------

// readPgDumpInt reads one integer from r using the pg_dump encoding:
//
//	1 sign byte (0 = positive, 1 = negative) followed by intSize bytes,
//	little-endian unsigned absolute value.
//
// This format is used for all archive versions > 1.0.
func readPgDumpInt(r io.Reader, intSize int) (int64, error) {
	sign := make([]byte, 1)
	if _, err := io.ReadFull(r, sign); err != nil {
		return 0, fmt.Errorf("readPgDumpInt sign: %w", err)
	}
	buf := make([]byte, intSize)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, fmt.Errorf("readPgDumpInt value: %w", err)
	}
	var val int64
	for i := 0; i < intSize; i++ {
		val |= int64(buf[i]) << (i * 8)
	}
	if sign[0] != 0 {
		val = -val
	}
	return val, nil
}

// readPgDumpStr reads a length-prefixed string from r.
// A length of -1 (NULL) or 0 both return "".
func readPgDumpStr(r io.Reader, intSize int) (string, error) {
	l, err := readPgDumpInt(r, intSize)
	if err != nil {
		return "", fmt.Errorf("readPgDumpStr len: %w", err)
	}
	if l <= 0 {
		return "", nil
	}
	buf := make([]byte, l)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", fmt.Errorf("readPgDumpStr data: %w", err)
	}
	return string(buf), nil
}

// readPgDumpOffset reads a pg_dump file-offset field.
// The encoding is: 1 flag byte followed by offSize little-endian value bytes
// (only when flag == kOffsetPosSet).
func readPgDumpOffset(r io.Reader, offSize int) (val int64, set bool, err error) {
	flag := make([]byte, 1)
	if _, err = io.ReadFull(r, flag); err != nil {
		return 0, false, fmt.Errorf("readPgDumpOffset flag: %w", err)
	}
	switch flag[0] {
	case kOffsetPosNotSet, kOffsetNoData:
		return 0, false, nil
	case kOffsetPosSet:
		buf := make([]byte, offSize)
		if _, err = io.ReadFull(r, buf); err != nil {
			return 0, false, fmt.Errorf("readPgDumpOffset value: %w", err)
		}
		for i := 0; i < offSize; i++ {
			val |= int64(buf[i]) << (i * 8)
		}
		return val, true, nil
	default:
		return 0, false, fmt.Errorf("readPgDumpOffset: unknown flag %d", flag[0])
	}
}

// ---------------------------------------------------------------------------
// pg_dump archive parser
// ---------------------------------------------------------------------------

// parsePgDump reads a pg_dump custom-format archive from r and returns a
// *pgDumpDoc containing the parsed header and full TOC.
//
// Supports format versions up to 1.16 (PostgreSQL 16).  Version-conditional
// fields (tableam @ 1.14, relkind @ 1.16, compressionAlgo @ 1.15) are handled
// automatically based on the version bytes in the archive header.
func parsePgDump(r io.ReadSeeker) (*pgDumpDoc, error) {
	// ---- magic ----
	magic := make([]byte, 5)
	if _, err := io.ReadFull(r, magic); err != nil {
		return nil, fmt.Errorf("parsePgDump: magic: %w", err)
	}
	if string(magic) != pgDumpMagic {
		return nil, fmt.Errorf("parsePgDump: invalid magic %q", magic)
	}

	// ---- fixed header bytes: vmaj vmin vrev intSize offSize format ----
	hdr := make([]byte, 6)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return nil, fmt.Errorf("parsePgDump: header bytes: %w", err)
	}
	vmaj, vmin, vrev := int(hdr[0]), int(hdr[1]), int(hdr[2])
	intSize, offSize := int(hdr[3]), int(hdr[4])
	ver := pgDumpVer(vmaj, vmin, vrev)

	doc := &pgDumpDoc{
		VMaj:    uint8(vmaj),
		VMin:    uint8(vmin),
		VRev:    uint8(vrev),
		IntSize: uint8(intSize),
		OffSize: uint8(offSize),
		Format:  hdr[5],
	}

	// ---- compression info (version-conditional) ----
	if ver >= pgDumpVer(1, 15, 0) {
		// PostgreSQL 16+: explicit compression algorithm
		algo, err := readPgDumpInt(r, intSize)
		if err != nil {
			return nil, fmt.Errorf("parsePgDump: compressionAlgo: %w", err)
		}
		doc.ComprAlgo = int32(algo)
	} else if ver >= pgDumpVer(1, 2, 0) {
		// PostgreSQL ≤ 15: compression level (discard)
		if _, err := readPgDumpInt(r, intSize); err != nil {
			return nil, fmt.Errorf("parsePgDump: compressionLevel: %w", err)
		}
	}

	// ---- remaining header strings ----
	// creation time (stored as int32 time_t)
	if _, err := readPgDumpInt(r, intSize); err != nil {
		return nil, fmt.Errorf("parsePgDump: crtm: %w", err)
	}
	for _, field := range []string{"dbname", "remoteVersion", "pgdumpVersion"} {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("parsePgDump: %s: %w", field, err)
		}
	}

	// ---- tablespace mappings (>= 1.10) ----
	if ver >= pgDumpVer(1, 10, 0) {
		count, err := readPgDumpInt(r, intSize)
		if err != nil {
			return nil, fmt.Errorf("parsePgDump: tablespace count: %w", err)
		}
		for i := int64(0); i < count; i++ {
			if _, err := readPgDumpStr(r, intSize); err != nil {
				return nil, fmt.Errorf("parsePgDump: tablespace name[%d]: %w", i, err)
			}
			if _, err := readPgDumpStr(r, intSize); err != nil {
				return nil, fmt.Errorf("parsePgDump: tablespace location[%d]: %w", i, err)
			}
		}
	}

	// ---- TOC ----
	tocCount, err := readPgDumpInt(r, intSize)
	if err != nil {
		return nil, fmt.Errorf("parsePgDump: tocCount: %w", err)
	}
	doc.TOC = make([]tocEntry, 0, tocCount)
	for i := int64(0); i < tocCount; i++ {
		entry, err := parseTocEntry(r, intSize, offSize, ver)
		if err != nil {
			return nil, fmt.Errorf("parsePgDump: TOC[%d]: %w", i, err)
		}
		entry.ComprAlgo = doc.ComprAlgo
		doc.TOC = append(doc.TOC, *entry)
	}

	return doc, nil
}

// parseTocEntry reads one TOC entry from r, honouring version-conditional fields.
func parseTocEntry(r io.Reader, intSize, offSize, ver int) (*tocEntry, error) {
	te := &tocEntry{}

	// dumpId
	dumpID, err := readPgDumpInt(r, intSize)
	if err != nil {
		return nil, fmt.Errorf("dumpID: %w", err)
	}
	te.DumpID = int32(dumpID)

	// hadDumper (bool as int)
	if _, err := readPgDumpInt(r, intSize); err != nil {
		return nil, fmt.Errorf("hadDumper: %w", err)
	}

	// tableoid (>= 1.3)
	if ver >= pgDumpVer(1, 3, 0) {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("tableoid: %w", err)
		}
	}

	// oid
	if _, err := readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("oid: %w", err)
	}

	// tag — the object name (table name for TABLE DATA entries)
	if te.Tag, err = readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("tag: %w", err)
	}

	// desc — object type ("TABLE DATA", "TABLE", "INDEX", …)
	if te.Desc, err = readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("desc: %w", err)
	}

	// section (>= 1.11)
	if ver >= pgDumpVer(1, 11, 0) {
		sec, err := readPgDumpInt(r, intSize)
		if err != nil {
			return nil, fmt.Errorf("section: %w", err)
		}
		te.Section = int32(sec)
	}

	// defn
	if _, err := readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("defn: %w", err)
	}

	// dropStmt
	if _, err := readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("dropStmt: %w", err)
	}

	// filename (only in old format < 1.3; discarded)
	if ver < pgDumpVer(1, 3, 0) {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("filename: %w", err)
		}
	}

	// copyStmt
	if te.CopyStmt, err = readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("copyStmt: %w", err)
	}

	// namespace
	if _, err := readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("namespace: %w", err)
	}

	// tablespace (>= 1.10)
	if ver >= pgDumpVer(1, 10, 0) {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("tablespace: %w", err)
		}
	}

	// tableam (>= 1.14)
	if ver >= pgDumpVer(1, 14, 0) {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("tableam: %w", err)
		}
	}

	// relkind (>= 1.16) — single-char string ("r", "v", "p", …)
	if ver >= pgDumpVer(1, 16, 0) {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("relkind: %w", err)
		}
	}

	// owner
	if _, err := readPgDumpStr(r, intSize); err != nil {
		return nil, fmt.Errorf("owner: %w", err)
	}

	// withOids only in old format (< 1.9); discarded
	if ver < pgDumpVer(1, 9, 0) {
		if _, err := readPgDumpStr(r, intSize); err != nil {
			return nil, fmt.Errorf("withOids: %w", err)
		}
	}

	// dependencies: strings terminated by NULL (returned as "" by readPgDumpStr)
	for {
		dep, err := readPgDumpStr(r, intSize)
		if err != nil {
			return nil, fmt.Errorf("dep: %w", err)
		}
		if dep == "" {
			break // NULL sentinel
		}
	}

	// dataLength (>= 1.8) — size of the data block; not needed, discard
	if ver >= pgDumpVer(1, 8, 0) {
		if _, _, err := readPgDumpOffset(r, offSize); err != nil {
			return nil, fmt.Errorf("dataLength: %w", err)
		}
	}

	// dataPos (>= 1.1) — byte offset of the data block
	if ver >= pgDumpVer(1, 1, 0) {
		te.DataOffset, te.DataOffsetSet, err = readPgDumpOffset(r, offSize)
		if err != nil {
			return nil, fmt.Errorf("dataPos: %w", err)
		}
	}

	return te, nil
}

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
