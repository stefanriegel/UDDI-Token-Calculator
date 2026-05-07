package efficientip

import (
	"archive/tar"
	"bytes"
	"encoding/binary"
	"fmt"

	"github.com/klauspost/compress/zstd"
)

// tableSpec describes one TABLE DATA entry for buildMinimalPgDump.
type tableSpec struct {
	Name     string
	CopyStmt string   // optional; defaults to "COPY public.<Name> FROM stdin;"
	Rows     []string // optional data rows (tab-separated fields, no newline)
}

// buildFullBackupFile generates a complete zstd-tar containing a pg_dump file
// with all 15 target tables and the synthetic counts from the task plan:
//   - DNS Zones: 734 (row_enabled=1)
//   - DNS Records (filtered): 2101 supported-type, row_enabled=1
//   - IP Sites: 1
//   - IPv4 Subnets: 249 (row_enabled=1)
//   - IPv6 Subnets: 0
//   - IPv4 Pools: 0
//   - IPv6 Pools: 0
//   - IPv4 Addresses (real_ip+free_ip): 1298 total
//   - IPv6 Addresses: 0
//   - DHCP4 Scopes: 37 (row_enabled=1)
//   - DHCP6 Scopes: 0
//   - DHCP4 Ranges: 37 (row_enabled=1)
//   - DHCP6 Ranges: 0
func buildFullBackupFile() ([]byte, error) {
	// Build rr_type rows covering all 13 supported types.
	// OIDs 1-13 map to the 13 supported types.
	supportedTypes := []string{
		"A", "AAAA", "CNAME", "MX", "TXT",
		"CAA", "SRV", "SVCB", "HTTPS", "PTR",
		"NS", "SOA", "NAPTR",
	}
	var rrTypeRows []string
	for i, typeName := range supportedTypes {
		rrTypeRows = append(rrTypeRows, fmt.Sprintf("%d\t%s", i+1, typeName))
	}
	// Add one unsupported type (OID 99) to make filtering meaningful.
	rrTypeRows = append(rrTypeRows, "99\tUNKNOWN")

	// generateRowsWithEnabled generates n rows with row_enabled=1 and (extra) rows with row_enabled=0.
	makeEnabledRows := func(n, extra int) []string {
		rows := make([]string, 0, n+extra)
		for i := 0; i < n; i++ {
			rows = append(rows, fmt.Sprintf("%d\t1\tval%d", i+1, i))
		}
		for i := 0; i < extra; i++ {
			rows = append(rows, fmt.Sprintf("%d\t0\tdisabled%d", n+i+1, i))
		}
		return rows
	}

	// DNS Records: 2101 enabled with supported rr_type_id, plus a few disabled/unsupported.
	var dnsRRRows []string
	id := 1
	// 2101 enabled supported rows (distribute across OIDs 1-13)
	for i := 0; i < 2101; i++ {
		oid := (i % 13) + 1
		dnsRRRows = append(dnsRRRows, fmt.Sprintf("%d\t1\t%d\trr%d.example.com", id, oid, id))
		id++
	}
	// 10 enabled unsupported (OID 99)
	for i := 0; i < 10; i++ {
		dnsRRRows = append(dnsRRRows, fmt.Sprintf("%d\t1\t99\tbad%d.example.com", id, i))
		id++
	}
	// 5 disabled
	for i := 0; i < 5; i++ {
		dnsRRRows = append(dnsRRRows, fmt.Sprintf("%d\t0\t1\tdisabled%d.example.com", id, i))
		id++
	}

	// IPv4 addresses: real_ip=1000, free_ip=298 → total 1298
	makeIPRows := func(n int) []string {
		rows := make([]string, n)
		for i := range rows {
			rows[i] = fmt.Sprintf("%d\t10.0.%d.%d", i+1, (i/256)%256, i%256)
		}
		return rows
	}

	tables := []tableSpec{
		// rr_type lookup
		{
			Name:     "rr_type",
			CopyStmt: "COPY public.rr_type (rr_type_id, rr_type_name) FROM stdin;",
			Rows:     rrTypeRows,
		},
		// DNS Zones: 734 enabled, 10 disabled
		{
			Name:     "real_dnszone",
			CopyStmt: "COPY public.real_dnszone (id, row_enabled, name) FROM stdin;",
			Rows:     makeEnabledRows(734, 10),
		},
		// DNS Records
		{
			Name:     "link_dnszone_rr",
			CopyStmt: "COPY public.link_dnszone_rr (id, row_enabled, rr_type_id, name) FROM stdin;",
			Rows:     dnsRRRows,
		},
		// IP Sites: 1 (no row_enabled)
		{
			Name:     "ip_site",
			CopyStmt: "COPY public.ip_site (ip_site_id, ip_site_name) FROM stdin;",
			Rows:     []string{"1\tdefault"},
		},
		// IPv4 Subnets: 249 enabled, 5 disabled
		{
			Name:     "ip_subnet",
			CopyStmt: "COPY public.ip_subnet (subnet_id, row_enabled, subnet_addr) FROM stdin;",
			Rows:     makeEnabledRows(249, 5),
		},
		// IPv6 Subnets: 0
		{
			Name:     "ip_subnet6",
			CopyStmt: "COPY public.ip_subnet6 (subnet_id, row_enabled, subnet_addr) FROM stdin;",
			Rows:     nil,
		},
		// IPv4 Pools: 0
		{
			Name:     "ip_pool",
			CopyStmt: "COPY public.ip_pool (pool_id, row_enabled, pool_name) FROM stdin;",
			Rows:     nil,
		},
		// IPv6 Pools: 0
		{
			Name:     "ip_pool6",
			CopyStmt: "COPY public.ip_pool6 (pool_id, row_enabled, pool_name) FROM stdin;",
			Rows:     nil,
		},
		// real_ip: 1000 rows
		{
			Name:     "real_ip",
			CopyStmt: "COPY public.real_ip (ip_id, ip_addr) FROM stdin;",
			Rows:     makeIPRows(1000),
		},
		// free_ip: 298 rows
		{
			Name:     "free_ip",
			CopyStmt: "COPY public.free_ip (ip_id, ip_addr) FROM stdin;",
			Rows:     makeIPRows(298),
		},
		// real_ip6: 0
		{
			Name:     "real_ip6",
			CopyStmt: "COPY public.real_ip6 (ip_id, ip_addr) FROM stdin;",
			Rows:     nil,
		},
		// free_ip6: 0
		{
			Name:     "free_ip6",
			CopyStmt: "COPY public.free_ip6 (ip_id, ip_addr) FROM stdin;",
			Rows:     nil,
		},
		// DHCP4 Scopes: 37 enabled, 3 disabled
		{
			Name:     "dhcp_scope",
			CopyStmt: "COPY public.dhcp_scope (scope_id, row_enabled, scope_name) FROM stdin;",
			Rows:     makeEnabledRows(37, 3),
		},
		// DHCP6 Scopes: 0
		{
			Name:     "dhcp_scope6",
			CopyStmt: "COPY public.dhcp_scope6 (scope_id, row_enabled, scope_name) FROM stdin;",
			Rows:     nil,
		},
		// DHCP4 Ranges: 37 enabled
		{
			Name:     "dhcp_range",
			CopyStmt: "COPY public.dhcp_range (range_id, row_enabled, range_name) FROM stdin;",
			Rows:     makeEnabledRows(37, 0),
		},
		// DHCP6 Ranges: 0
		{
			Name:     "dhcp_range6",
			CopyStmt: "COPY public.dhcp_range6 (range_id, row_enabled, range_name) FROM stdin;",
			Rows:     nil,
		},
	}

	raw := buildMinimalPgDump(tables)
	return buildMinimalZstdTar(raw)
}
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

// writeDataBlock writes an uncompressed pg_dump data block for the given rows.
// Format: blockType(1)=1, dumpId(4), chunkLen(4), data, chunkLen(4)=0.
func writeDataBlock(buf *bytes.Buffer, dumpID int32, rows []string) {
	// block type = 1 (data)
	buf.WriteByte(1)
	// dumpId: plain 4-byte little-endian
	var idBuf [4]byte
	binary.LittleEndian.PutUint32(idBuf[:], uint32(dumpID))
	buf.Write(idBuf[:])

	// Build payload: rows then terminator
	var payload bytes.Buffer
	for _, row := range rows {
		payload.WriteString(row)
		payload.WriteByte('\n')
	}
	payload.WriteString(`\.`)
	payload.WriteByte('\n')

	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(payload.Len()))
	buf.Write(lenBuf[:])
	buf.Write(payload.Bytes())

	// chunk terminator: chunkLen=0
	var zero [4]byte
	buf.Write(zero[:])
}

// strFieldSize returns the byte size of a pg_dump string field in wire format.
func strFieldSize(s string, intSize int) int {
	if s == "" {
		return 1 + intSize // sign + zero bytes
	}
	return 1 + intSize + len(s)
}

// measureTOC computes the total byte size of all TOC entries for the given tables.
func measureTOC(tables []tableSpec, intSize, offSize int) int {
	total := 0
	for _, ts := range tables {
		copyStmt := ts.CopyStmt
		if copyStmt == "" {
			copyStmt = "COPY public." + ts.Name + " FROM stdin;"
		}
		total += (1 + intSize) * 3                  // dumpId, hadDumper, section
		total += strFieldSize("16400", intSize)      // tableoid
		total += strFieldSize("16400", intSize)      // oid
		total += strFieldSize(ts.Name, intSize)      // tag
		total += strFieldSize("TABLE DATA", intSize) // desc
		total += strFieldSize("", intSize)           // defn
		total += strFieldSize("", intSize)           // dropStmt
		total += strFieldSize(copyStmt, intSize)     // copyStmt
		total += strFieldSize("public", intSize)     // namespace
		total += strFieldSize("", intSize)           // tablespace
		total += strFieldSize("heap", intSize)       // tableam
		total += strFieldSize("r", intSize)          // relkind
		total += strFieldSize("postgres", intSize)   // owner
		total += strFieldSize("", intSize)           // dep sentinel
		total += 1 + 0                               // dataLength: kOffsetPosNotSet flag only
		total += 1 + offSize                         // dataPos: kOffsetPosSet + 8 bytes
	}
	return total
}

// buildMinimalPgDump produces a valid pg_dump custom-format binary in memory.
// Header: magic PGDMP, version {1,16,0}, intSize=4, offSize=8, format=3,
// compressionAlgo=0 (none).
// One TABLE DATA TOC entry is emitted per element of tables.
// Data blocks (uncompressed) are appended after the TOC; DataOffset in each
// tocEntry points to the corresponding data block.
func buildMinimalPgDump(tables []tableSpec) []byte {
	const intSize = 4
	const offSize = 8

	// Compute where data starts (after header + TOC).
	headerSize := 5 + 6 + // "PGDMP" + {vmaj,vmin,vrev,intSize,offSize,format}
		(1 + intSize) + // compressionAlgo
		(1 + intSize) + // crtm
		strFieldSize("testdb", intSize) +
		strFieldSize("160001", intSize) +
		strFieldSize("pg_dump (PostgreSQL) 16.1", intSize) +
		(1 + intSize) + // tablespace count = 0
		(1 + intSize) // TOC count
	tocSize := measureTOC(tables, intSize, offSize)
	dataStart := int64(headerSize + tocSize)

	// Build data section and record offsets.
	var dataSection bytes.Buffer
	dataOffsets := make([]int64, len(tables))
	for i, ts := range tables {
		dataOffsets[i] = dataStart + int64(dataSection.Len())
		writeDataBlock(&dataSection, int32(i+1), ts.Rows)
	}

	// Build final output.
	w := &pgDumpWriter{intSize: intSize, offSize: offSize}
	b := &w.b

	b.WriteString(pgDumpMagic)
	b.Write([]byte{1, 16, 0, 4, 8, 3})
	w.writeInt(0) // compressionAlgo = 0 (none)
	w.writeInt(0) // crtm
	w.writeStr("testdb")
	w.writeStr("160001")
	w.writeStr("pg_dump (PostgreSQL) 16.1")
	w.writeInt(0) // tablespace count
	w.writeInt(int64(len(tables)))

	for i, ts := range tables {
		copyStmt := ts.CopyStmt
		if copyStmt == "" {
			copyStmt = "COPY public." + ts.Name + " FROM stdin;"
		}
		w.writeInt(int64(i + 1)) // dumpId
		w.writeInt(1)            // hadDumper
		w.writeStr("16400")      // tableoid
		w.writeStr("16400")      // oid
		w.writeStr(ts.Name)      // tag
		w.writeStr("TABLE DATA") // desc
		w.writeInt(2)            // section = SECTION_DATA
		w.writeStr("")           // defn
		w.writeStr("")           // dropStmt
		w.writeStr(copyStmt)     // copyStmt
		w.writeStr("public")     // namespace
		w.writeStr("")           // tablespace
		w.writeStr("heap")       // tableam
		w.writeStr("r")          // relkind
		w.writeStr("postgres")   // owner
		w.writeStr("")           // dep sentinel (NULL)
		w.writeOffset(0, false)  // dataLength: not set
		w.writeOffset(dataOffsets[i], true) // dataPos
	}

	b.Write(dataSection.Bytes())
	return b.Bytes()
}
