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
		{Name: "ip_address"},
		{Name: "ip_subnet"},
		{Name: "ip_space"},
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
		if entry.DataOffset <= 0 {
			t.Errorf("TOC[%d].DataOffset = %d, want > 0", i, entry.DataOffset)
		}
	}
}

// ---------------------------------------------------------------------------
// TestCountTableRows
// ---------------------------------------------------------------------------

func TestCountTableRows(t *testing.T) {
	// Build a pg_dump with several tables that exercise all filter paths.
	//
	// Tables:
	//   rr_type          — lookup table: maps OID → type name
	//   link_dnszone_rr  — DNS records; filtered by row_enabled AND rr_type_id
	//   real_dnszone     — zones; filtered by row_enabled only
	//   ip_address       — unfiltered (no row_enabled, no rr_type)
	//   (free_ip not present — must return 0 with no error)

	// rr_type rows: (rr_type_id, rr_type_name)
	// OIDs 1=A, 2=AAAA, 3=CNAME, 9=UNKNOWN (not in supportedDNSRecordTypes)
	rrTypeRows := []string{
		"1\tA",
		"2\tAAAA",
		"3\tCNAME",
		"9\tUNKNOWN",
	}

	// link_dnszone_rr rows: (id, row_enabled, rr_type_id, name)
	// Want: row_enabled=1 AND rr_type_id in {1,2,3} → count 3
	dnsRRRows := []string{
		"101\t1\t1\texample.com.",   // enabled, A       → counted
		"102\t1\t2\texample.com.",   // enabled, AAAA    → counted
		"103\t0\t1\texample.com.",   // disabled         → skip
		"104\t1\t9\texample.com.",   // enabled, UNKNOWN → skip
		"105\t1\t3\texample.com.",   // enabled, CNAME   → counted
	}

	// real_dnszone rows: (id, row_enabled, name)
	// Want: row_enabled=1 → count 4
	zoneRows := []string{
		"1\t1\texample.com",
		"2\t1\texample.net",
		"3\t0\tdisabled.com",
		"4\t1\texample.org",
		"5\t1\texample.io",
	}

	// ip_address rows: (id, addr) — no filtering → count all 3
	ipRows := []string{
		"1\t10.0.0.1",
		"2\t10.0.0.2",
		"3\t10.0.0.3",
	}

	tables := []tableSpec{
		{
			Name:     "rr_type",
			CopyStmt: "COPY public.rr_type (rr_type_id, rr_type_name) FROM stdin;",
			Rows:     rrTypeRows,
		},
		{
			Name:     "link_dnszone_rr",
			CopyStmt: "COPY public.link_dnszone_rr (id, row_enabled, rr_type_id, name) FROM stdin;",
			Rows:     dnsRRRows,
		},
		{
			Name:     "real_dnszone",
			CopyStmt: "COPY public.real_dnszone (id, row_enabled, name) FROM stdin;",
			Rows:     zoneRows,
		},
		{
			Name:     "ip_address",
			CopyStmt: "COPY public.ip_address (id, addr) FROM stdin;",
			Rows:     ipRows,
		},
	}

	raw := buildMinimalPgDump(tables)
	rs := bytes.NewReader(raw)

	doc, err := parsePgDump(rs)
	if err != nil {
		t.Fatalf("parsePgDump: %v", err)
	}

	// Index TOC entries by table name.
	byName := make(map[string]tocEntry)
	for _, e := range doc.TOC {
		byName[e.Tag] = e
	}

	// --- rr_type map ---
	rrTypeEntry, ok := byName["rr_type"]
	if !ok {
		t.Fatal("rr_type not found in TOC")
	}
	rrTypeMap, err := buildRRTypeMap(rs, rrTypeEntry, 0)
	if err != nil {
		t.Fatalf("buildRRTypeMap: %v", err)
	}
	// A(1), AAAA(2), CNAME(3) should be present; UNKNOWN(9) should not.
	for _, wantOID := range []string{"1", "2", "3"} {
		if _, found := rrTypeMap[wantOID]; !found {
			t.Errorf("rrTypeMap missing OID %q", wantOID)
		}
	}
	if _, found := rrTypeMap["9"]; found {
		t.Error("rrTypeMap should not contain OID 9 (UNKNOWN type)")
	}

	// --- link_dnszone_rr: row_enabled + rr_type_id filter ---
	dnsRREntry, ok := byName["link_dnszone_rr"]
	if !ok {
		t.Fatal("link_dnszone_rr not found in TOC")
	}
	cf := buildColumnFilter(dnsRREntry, rrTypeMap)
	got, err := countTableRows(rs, dnsRREntry, 0, cf)
	if err != nil {
		t.Fatalf("countTableRows link_dnszone_rr: %v", err)
	}
	if got != 3 {
		t.Errorf("link_dnszone_rr row count: got %d, want 3", got)
	}

	// --- real_dnszone: row_enabled filter only ---
	zoneEntry, ok := byName["real_dnszone"]
	if !ok {
		t.Fatal("real_dnszone not found in TOC")
	}
	cfZone := buildColumnFilter(zoneEntry, nil)
	got, err = countTableRows(rs, zoneEntry, 0, cfZone)
	if err != nil {
		t.Fatalf("countTableRows real_dnszone: %v", err)
	}
	if got != 4 {
		t.Errorf("real_dnszone row count: got %d, want 4", got)
	}

	// --- ip_address: no filter ---
	ipEntry, ok := byName["ip_address"]
	if !ok {
		t.Fatal("ip_address not found in TOC")
	}
	got, err = countTableRows(rs, ipEntry, 0, noFilter())
	if err != nil {
		t.Fatalf("countTableRows ip_address: %v", err)
	}
	if got != 3 {
		t.Errorf("ip_address row count: got %d, want 3", got)
	}

	// --- free_ip: not present in TOC → must return 0 with DataOffsetSet=false ---
	missingEntry := tocEntry{DataOffsetSet: false}
	got, err = countTableRows(rs, missingEntry, 0, noFilter())
	if err != nil {
		t.Fatalf("countTableRows missing entry: %v", err)
	}
	if got != 0 {
		t.Errorf("missing entry row count: got %d, want 0", got)
	}
}
