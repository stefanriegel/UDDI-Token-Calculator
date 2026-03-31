package efficientip

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/klauspost/compress/zstd"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
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

// ---------------------------------------------------------------------------
// Data block reader — row counting with column filters
// ---------------------------------------------------------------------------

// columnFilter controls which rows are counted.
type columnFilter struct {
	// rowEnabledCol is the zero-based column index of "row_enabled".
	// -1 means no filter.
	rowEnabledCol int
	// rrTypeCol is the zero-based column index of "rr_type_id".
	// -1 means no filter.
	rrTypeCol int
	// allowedRRTypes is the set of rr_type_id OID strings to accept.
	// nil means accept all.
	allowedRRTypes map[string]struct{}
}

// noFilter returns a columnFilter that counts every row.
func noFilter() columnFilter {
	return columnFilter{rowEnabledCol: -1, rrTypeCol: -1}
}

// parseCopyColumns parses column names from a COPY statement like
//
//	COPY public.foo (col1, col2, col3) FROM stdin;
//
// and returns a slice of column names in declaration order.
func parseCopyColumns(copyStmt string) []string {
	// Find the opening and closing parentheses.
	open := -1
	for i, c := range copyStmt {
		if c == '(' {
			open = i
			break
		}
	}
	if open < 0 {
		return nil
	}
	close := -1
	for i := open + 1; i < len(copyStmt); i++ {
		if copyStmt[i] == ')' {
			close = i
			break
		}
	}
	if close < 0 {
		return nil
	}
	inner := copyStmt[open+1 : close]
	var cols []string
	for _, part := range splitComma(inner) {
		col := strings.TrimSpace(part)
		if col != "" {
			cols = append(cols, col)
		}
	}
	return cols
}

// splitComma splits s on commas (not inside parentheses).
func splitComma(s string) []string {
	var parts []string
	depth := 0
	start := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, s[start:i])
				start = i + 1
			}
		}
	}
	parts = append(parts, s[start:])
	return parts
}

// columnIndex returns the 0-based index of name in cols, or -1 if absent.
func columnIndex(cols []string, name string) int {
	for i, c := range cols {
		if c == name {
			return i
		}
	}
	return -1
}

// buildColumnFilter constructs a columnFilter for entry given the COPY columns.
func buildColumnFilter(entry tocEntry, rrTypeMap map[string]struct{}) columnFilter {
	cols := parseCopyColumns(entry.CopyStmt)
	cf := columnFilter{rowEnabledCol: -1, rrTypeCol: -1}
	if idx := columnIndex(cols, "row_enabled"); idx >= 0 {
		cf.rowEnabledCol = idx
	}
	if rrTypeMap != nil {
		if idx := columnIndex(cols, "rr_type_id"); idx >= 0 {
			cf.rrTypeCol = idx
			cf.allowedRRTypes = rrTypeMap
		}
	}
	return cf
}

// countTableRows seeks to entry.DataOffset in r, reads and decompresses the
// data block, and returns the number of COPY rows that pass cf.
func countTableRows(r io.ReadSeeker, entry tocEntry, globalCompression byte, cf columnFilter) (int, error) {
	if !entry.DataOffsetSet {
		return 0, nil
	}
	if _, err := r.Seek(entry.DataOffset, io.SeekStart); err != nil {
		return 0, fmt.Errorf("countTableRows seek: %w", err)
	}

	// Block header: blockType (1 byte), dumpId (int)
	blkType := make([]byte, 1)
	if _, err := io.ReadFull(r, blkType); err != nil {
		return 0, fmt.Errorf("countTableRows blockType: %w", err)
	}
	if blkType[0] == 3 { // EOF block
		return 0, nil
	}
	if blkType[0] != 1 { // not a data block
		return 0, fmt.Errorf("countTableRows: unexpected blockType %d", blkType[0])
	}
	// dumpId — 4-byte little-endian int (pg_dump writes plain int32 here)
	dumpIDBuf := make([]byte, 4)
	if _, err := io.ReadFull(r, dumpIDBuf); err != nil {
		return 0, fmt.Errorf("countTableRows dumpId: %w", err)
	}

	// Determine compression: entry overrides global if set, else use global.
	comprAlgo := entry.ComprAlgo
	if globalCompression != 0 && comprAlgo == 0 {
		comprAlgo = int32(globalCompression)
	}

	// Read chunks: chunkLen (4-byte int) then data; chunkLen==0 means end.
	var plainBuf bytes.Buffer
	chunkLenBuf := make([]byte, 4)
	for {
		if _, err := io.ReadFull(r, chunkLenBuf); err != nil {
			return 0, fmt.Errorf("countTableRows chunkLen: %w", err)
		}
		chunkLen := int(binary.LittleEndian.Uint32(chunkLenBuf))
		if chunkLen == 0 {
			break
		}
		chunk := make([]byte, chunkLen)
		if _, err := io.ReadFull(r, chunk); err != nil {
			return 0, fmt.Errorf("countTableRows chunk data: %w", err)
		}
		switch comprAlgo {
		case 0: // raw
			plainBuf.Write(chunk)
		case 1: // gzip
			gr, err := gzip.NewReader(bytes.NewReader(chunk))
			if err != nil {
				return 0, fmt.Errorf("countTableRows gzip open: %w", err)
			}
			if _, err := io.Copy(&plainBuf, gr); err != nil {
				return 0, fmt.Errorf("countTableRows gzip copy: %w", err)
			}
			gr.Close()
		case 4: // zstd
			zr, err := zstd.NewReader(bytes.NewReader(chunk))
			if err != nil {
				return 0, fmt.Errorf("countTableRows zstd open: %w", err)
			}
			if _, err := io.Copy(&plainBuf, zr); err != nil {
				return 0, fmt.Errorf("countTableRows zstd copy: %w", err)
			}
			zr.Close()
		default:
			return 0, fmt.Errorf("countTableRows: unknown comprAlgo %d", comprAlgo)
		}
	}

	// Count rows, applying column filters.
	return countRows(plainBuf.Bytes(), cf), nil
}

// countRows counts COPY rows in plain (uncompressed) pg_dump COPY output,
// skipping the terminator line "\." and applying cf.
func countRows(data []byte, cf columnFilter) int {
	count := 0
	for len(data) > 0 {
		// Find next newline.
		idx := bytes.IndexByte(data, '\n')
		var line []byte
		if idx < 0 {
			line = data
			data = nil
		} else {
			line = data[:idx]
			data = data[idx+1:]
		}
		// Skip terminator.
		if bytes.Equal(line, []byte(`\.`)) {
			continue
		}
		if len(line) == 0 {
			continue
		}
		if cf.rowEnabledCol >= 0 || cf.rrTypeCol >= 0 {
			fields := bytes.Split(line, []byte("\t"))
			if cf.rowEnabledCol >= 0 {
				if cf.rowEnabledCol >= len(fields) || string(fields[cf.rowEnabledCol]) != "1" {
					continue
				}
			}
			if cf.rrTypeCol >= 0 && cf.allowedRRTypes != nil {
				if cf.rrTypeCol >= len(fields) {
					continue
				}
				if _, ok := cf.allowedRRTypes[string(fields[cf.rrTypeCol])]; !ok {
					continue
				}
			}
		}
		count++
	}
	return count
}

// buildRRTypeMap reads the rr_type table from r and returns the set of OID
// values whose type name appears in supportedDNSRecordTypes (from scanner.go).
func buildRRTypeMap(r io.ReadSeeker, entry tocEntry, globalCompression byte) (map[string]struct{}, error) {
	if !entry.DataOffsetSet {
		return nil, nil
	}
	if _, err := r.Seek(entry.DataOffset, io.SeekStart); err != nil {
		return nil, fmt.Errorf("buildRRTypeMap seek: %w", err)
	}

	// Block header.
	blkType := make([]byte, 1)
	if _, err := io.ReadFull(r, blkType); err != nil {
		return nil, fmt.Errorf("buildRRTypeMap blockType: %w", err)
	}
	if blkType[0] != 1 {
		return nil, nil
	}
	dumpIDBuf := make([]byte, 4)
	if _, err := io.ReadFull(r, dumpIDBuf); err != nil {
		return nil, fmt.Errorf("buildRRTypeMap dumpId: %w", err)
	}

	comprAlgo := entry.ComprAlgo
	if globalCompression != 0 && comprAlgo == 0 {
		comprAlgo = int32(globalCompression)
	}

	var plainBuf bytes.Buffer
	chunkLenBuf := make([]byte, 4)
	for {
		if _, err := io.ReadFull(r, chunkLenBuf); err != nil {
			return nil, fmt.Errorf("buildRRTypeMap chunkLen: %w", err)
		}
		chunkLen := int(binary.LittleEndian.Uint32(chunkLenBuf))
		if chunkLen == 0 {
			break
		}
		chunk := make([]byte, chunkLen)
		if _, err := io.ReadFull(r, chunk); err != nil {
			return nil, fmt.Errorf("buildRRTypeMap chunk: %w", err)
		}
		switch comprAlgo {
		case 0:
			plainBuf.Write(chunk)
		case 1:
			gr, err := gzip.NewReader(bytes.NewReader(chunk))
			if err != nil {
				return nil, fmt.Errorf("buildRRTypeMap gzip: %w", err)
			}
			if _, err := io.Copy(&plainBuf, gr); err != nil {
				return nil, fmt.Errorf("buildRRTypeMap gzip copy: %w", err)
			}
			gr.Close()
		case 4:
			zr, err := zstd.NewReader(bytes.NewReader(chunk))
			if err != nil {
				return nil, fmt.Errorf("buildRRTypeMap zstd: %w", err)
			}
			if _, err := io.Copy(&plainBuf, zr); err != nil {
				return nil, fmt.Errorf("buildRRTypeMap zstd copy: %w", err)
			}
			zr.Close()
		default:
			return nil, fmt.Errorf("buildRRTypeMap: unknown comprAlgo %d", comprAlgo)
		}
	}

	// Parse rr_type rows: columns must include "rr_type_id" (OID) and "rr_type_name".
	cols := parseCopyColumns(entry.CopyStmt)
	oidIdx := columnIndex(cols, "rr_type_id")
	nameIdx := columnIndex(cols, "rr_type_name")
	if oidIdx < 0 || nameIdx < 0 {
		return nil, fmt.Errorf("buildRRTypeMap: rr_type table missing expected columns (have %v)", cols)
	}

	result := make(map[string]struct{})
	data := plainBuf.Bytes()
	for len(data) > 0 {
		idx := bytes.IndexByte(data, '\n')
		var line []byte
		if idx < 0 {
			line = data
			data = nil
		} else {
			line = data[:idx]
			data = data[idx+1:]
		}
		if bytes.Equal(line, []byte(`\.`)) || len(line) == 0 {
			continue
		}
		fields := bytes.Split(line, []byte("\t"))
		if nameIdx >= len(fields) || oidIdx >= len(fields) {
			continue
		}
		name := string(fields[nameIdx])
		if _, ok := supportedDNSRecordTypes[name]; ok {
			result[string(fields[oidIdx])] = struct{}{}
		}
	}
	return result, nil
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

// ---------------------------------------------------------------------------
// ScanBackup — public entry point for backup-mode scanning
// ---------------------------------------------------------------------------

// backupTableDef maps a pg table name to its role in the scan result.
type backupTableDef struct {
	table       string
	item        string
	category    string
	tokensPerUnit int
	needsRowEnabled bool
	needsRRType     bool // filter by rr_type_id (requires rr_type lookup table)
}

// backupTables lists the 15 target tables in order of processing.
// Two address tables (real_ip + free_ip) are summed into one FindingRow.
var backupTables = []backupTableDef{
	// DNS
	{"real_dnszone",      "EfficientIP DNS Zones",                    calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true, false},
	{"link_dnszone_rr",   "EfficientIP DNS Records (Supported Types)", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true, true},
	// IPAM
	{"ip_site",           "EfficientIP IP Sites",    calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, false, false},
	{"ip_subnet",         "EfficientIP IP4 Subnets", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true,  false},
	{"ip_subnet6",        "EfficientIP IP6 Subnets", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true,  false},
	{"ip_pool",           "EfficientIP IP4 Pools",   calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true,  false},
	{"ip_pool6",          "EfficientIP IP6 Pools",   calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true,  false},
	// Addresses are special: real_ip + free_ip → one row (see ScanBackup)
	{"real_ip",           "_ip4_addresses_a", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, false, false},
	{"free_ip",           "_ip4_addresses_b", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, false, false},
	{"real_ip6",          "_ip6_addresses_a", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, false, false},
	{"free_ip6",          "_ip6_addresses_b", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, false, false},
	// DHCP
	{"dhcp_scope",        "EfficientIP DHCP4 Scopes", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true, false},
	{"dhcp_scope6",       "EfficientIP DHCP6 Scopes", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true, false},
	{"dhcp_range",        "EfficientIP DHCP4 Ranges", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true, false},
	{"dhcp_range6",       "EfficientIP DHCP6 Ranges", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, true, false},
}

// ScanBackup opens a SOLIDserver backup archive at path, parses the embedded
// pg_dump file, counts rows in each of the 15 DDI tables (applying
// row_enabled and DNS record-type filters), and returns []calculator.FindingRow
// in the same shape as the live API scanner.
func ScanBackup(ctx context.Context, path string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "backup_open", Status: "in_progress", Message: "Opening backup archive"})

	rs, cleanup, err := openBackupFile(path)
	if err != nil {
		return nil, fmt.Errorf("ScanBackup: %w", err)
	}
	defer cleanup()

	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "backup_parse", Status: "in_progress", Message: "Parsing pg_dump TOC"})
	doc, err := parsePgDump(rs)
	if err != nil {
		return nil, fmt.Errorf("ScanBackup: parsePgDump: %w", err)
	}

	// Index TOC entries by table name (only TABLE DATA sections).
	tocByName := make(map[string]tocEntry)
	for _, e := range doc.TOC {
		if e.Desc == "TABLE DATA" {
			tocByName[e.Tag] = e
		}
	}

	// Build rr_type → OID map for DNS record-type filtering.
	var rrTypeMap map[string]struct{}
	if e, ok := tocByName["rr_type"]; ok {
		rrTypeMap, err = buildRRTypeMap(rs, e, byte(doc.ComprAlgo))
		if err != nil {
			return nil, fmt.Errorf("ScanBackup: buildRRTypeMap: %w", err)
		}
	}

	// Count each table.
	counts := make(map[string]int, len(backupTables))
	for _, def := range backupTables {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		entry, ok := tocByName[def.table]
		if !ok {
			counts[def.table] = 0
			continue
		}
		var cf columnFilter
		if def.needsRRType {
			cf = buildColumnFilter(entry, rrTypeMap)
		} else if def.needsRowEnabled {
			cf = buildColumnFilter(entry, nil)
		} else {
			cf = noFilter()
		}
		n, err := countTableRows(rs, entry, byte(doc.ComprAlgo), cf)
		if err != nil {
			return nil, fmt.Errorf("ScanBackup: countTableRows %q: %w", def.table, err)
		}
		counts[def.table] = n
		publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: def.table, Count: n, Status: "done"})
	}

	// Assemble FindingRows.
	var rows []calculator.FindingRow

	// DNS Zones
	rows = append(rows, backupFinding("EfficientIP DNS Zones", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["real_dnszone"]))
	// DNS Records (supported types only)
	rows = append(rows, backupFinding("EfficientIP DNS Records (Supported Types)", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["link_dnszone_rr"]))
	// IP Sites
	rows = append(rows, backupFinding("EfficientIP IP Sites", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["ip_site"]))
	// IPv4 Subnets
	rows = append(rows, backupFinding("EfficientIP IP4 Subnets", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["ip_subnet"]))
	// IPv6 Subnets
	rows = append(rows, backupFinding("EfficientIP IP6 Subnets", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["ip_subnet6"]))
	// IPv4 Pools
	rows = append(rows, backupFinding("EfficientIP IP4 Pools", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["ip_pool"]))
	// IPv6 Pools
	rows = append(rows, backupFinding("EfficientIP IP6 Pools", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["ip_pool6"]))
	// IPv4 Addresses (real_ip + free_ip combined)
	ip4Count := counts["real_ip"] + counts["free_ip"]
	rows = append(rows, backupFinding("EfficientIP IP4 Addresses", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, ip4Count))
	// IPv6 Addresses (real_ip6 + free_ip6 combined)
	ip6Count := counts["real_ip6"] + counts["free_ip6"]
	rows = append(rows, backupFinding("EfficientIP IP6 Addresses", calculator.CategoryActiveIPs, calculator.TokensPerActiveIP, ip6Count))
	// DHCP4 Scopes
	rows = append(rows, backupFinding("EfficientIP DHCP4 Scopes", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["dhcp_scope"]))
	// DHCP6 Scopes
	rows = append(rows, backupFinding("EfficientIP DHCP6 Scopes", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["dhcp_scope6"]))
	// DHCP4 Ranges
	rows = append(rows, backupFinding("EfficientIP DHCP4 Ranges", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["dhcp_range"]))
	// DHCP6 Ranges
	rows = append(rows, backupFinding("EfficientIP DHCP6 Ranges", calculator.CategoryDDIObjects, calculator.TokensPerDDIObject, counts["dhcp_range6"]))

	publish(scanner.Event{Type: "provider_complete", Provider: "efficientip", Status: "done", Count: len(rows)})
	return rows, nil
}

// backupFinding creates a FindingRow for a backup-mode scan result.
func backupFinding(item, category string, tokensPerUnit, count int) calculator.FindingRow {
	return calculator.FindingRow{
		Provider:         "efficientip",
		Source:           "backup",
		Region:           "",
		Category:         category,
		Item:             item,
		Count:            count,
		TokensPerUnit:    tokensPerUnit,
		ManagementTokens: ceilDiv(count, tokensPerUnit),
	}
}
