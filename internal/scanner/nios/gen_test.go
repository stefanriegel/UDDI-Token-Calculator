// Package nios_test contains test helpers and stubs for the NIOS scanner.
// gen_test.go generates the synthetic testdata/minimal.tar.gz fixture used by all
// scanner tests. Run with: go test ./internal/scanner/nios/... -run TestGenerateMinimalFixture -v
package nios_test

import (
	"archive/tar"
	"compress/gzip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

const minimalOnedbXML = `<?xml version="1.0" encoding="UTF-8"?>
<DATABASE NAME="onedb" VERSION="9.0.6-test">
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="101"/>
<PROPERTY NAME="host_name" VALUE="gm.test.local"/>
<PROPERTY NAME="is_grid_master" VALUE="true"/>
<PROPERTY NAME="is_candidate_master" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="102"/>
<PROPERTY NAME="host_name" VALUE="dns1.test.local"/>
<PROPERTY NAME="is_grid_master" VALUE="false"/>
<PROPERTY NAME="is_candidate_master" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.virtual_node"/>
<PROPERTY NAME="virtual_oid" VALUE="103"/>
<PROPERTY NAME="host_name" VALUE="dhcp1.test.local"/>
<PROPERTY NAME="is_grid_master" VALUE="false"/>
<PROPERTY NAME="enable_dhcp" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
<PROPERTY NAME="vnode_id" VALUE="101"/>
<PROPERTY NAME="binding_state" VALUE="active"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.1"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
<PROPERTY NAME="vnode_id" VALUE="101"/>
<PROPERTY NAME="binding_state" VALUE="active"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.2"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
<PROPERTY NAME="vnode_id" VALUE="101"/>
<PROPERTY NAME="binding_state" VALUE="active"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.3"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="fqdn" VALUE="test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="fqdn" VALUE="arpa.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.fixed_address"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.50"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.host_address"/>
<PROPERTY NAME="address" VALUE="10.0.0.51"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.network"/>
<PROPERTY NAME="cidr" VALUE="10.0.1.0/24"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.discovery_data"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.1"/>
<PROPERTY NAME="discovered_name" VALUE="host1.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.discovery_data"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.100"/>
<PROPERTY NAME="discovered_name" VALUE="host2.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.idns_lbdn"/>
<PROPERTY NAME="name" VALUE="app.test.local"/>
</OBJECT>
</DATABASE>
`

// TestGenerateMinimalFixture writes internal/scanner/nios/testdata/minimal.tar.gz.
// The file is a valid gzip+tar archive containing a single entry "onedb.xml" with
// 3 Grid Members (GM + DNS-only + DHCP-only), 3 active LEASE objects, 2 DNS zones,
// 1 fixed address, 1 host address, 1 network, 2 discovery_data objects, and 1 idns_lbdn.
//
// The test is idempotent: if the file already exists it is overwritten to ensure
// the fixture stays in sync with this definition. Pass -regen flag (not required
// for normal test runs) to force regeneration.
func TestGenerateMinimalFixture(t *testing.T) {
	t.Helper()

	xmlData := []byte(minimalOnedbXML)

	// Build the tar.gz in memory.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	hdr := &tar.Header{
		Name: "onedb.xml",
		Mode: 0600,
		Size: int64(len(xmlData)),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatalf("tar WriteHeader: %v", err)
	}
	if _, err := tw.Write(xmlData); err != nil {
		t.Fatalf("tar Write: %v", err)
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar Close: %v", err)
	}
	if err := gw.Close(); err != nil {
		t.Fatalf("gzip Close: %v", err)
	}

	// Resolve path relative to this test file's package directory.
	outPath := filepath.Join("testdata", "minimal.tar.gz")

	if err := os.MkdirAll(filepath.Dir(outPath), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(outPath, buf.Bytes(), 0644); err != nil {
		t.Fatalf("WriteFile %s: %v", outPath, err)
	}

	t.Logf("wrote %d bytes to %s", buf.Len(), outPath)
}
