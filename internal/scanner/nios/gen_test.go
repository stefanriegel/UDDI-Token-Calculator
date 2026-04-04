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

// minimalOnedbXML defines a synthetic NIOS onedb.xml with:
//   - 3 Grid Members: GM (101), dns1 (102), dhcp1 (103)
//   - 1 ns_group_grid_primary linking "primary-group" → dns1 (OID 102)
//   - 5 DNS zones:
//     - test.local: assigned_ns_group="primary-group" → resolves to dns1 via ns_group
//     - arpa.test.local: no ns_group, no SOA → GM fallback
//     - soa-only.test.local: assigned_ns_group="nonexistent-group" → SOA fallback to dns1
//     - orphan.test.local: no assigned_ns_group → SOA fallback to dns1
//     - gm-fallback.test.local: assigned_ns_group="another-nonexistent", no SOA → GM fallback
//   - 2 bind_soa objects (confirmed property name "mname" from Schneider backup):
//     - soa-only.test.local → mname="dns1.test.local." (trailing dot, tests normalization)
//     - orphan.test.local → mname="dns1.test.local" (no trailing dot)
//   - 2 bind_a records in SOA-fallback zones (for DDI attribution testing)
//   - 2 dhcp_member mappings, 6 leases, 1 fixed address, 1 host address, 2 networks
//   - 2 discovery_data, 1 idns_lbdn, 2 host objects
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
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.ns_group_grid_primary"/>
<PROPERTY NAME="ns_group" VALUE="primary-group"/>
<PROPERTY NAME="grid_member" VALUE="102"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dns_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dns_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dns_properties"/>
<PROPERTY NAME="service_enabled" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dhcp_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
<PROPERTY NAME="static_hosts" VALUE="718"/>
<PROPERTY NAME="dynamic_hosts" VALUE="1490"/>
<PROPERTY NAME="total_hosts" VALUE="8235"/>
<PROPERTY NAME="dhcp_utilization" VALUE="268"/>
<PROPERTY NAME="v6_service_enable" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dhcp_properties"/>
<PROPERTY NAME="service_enabled" VALUE="false"/>
<PROPERTY NAME="static_hosts" VALUE="0"/>
<PROPERTY NAME="dynamic_hosts" VALUE="0"/>
<PROPERTY NAME="total_hosts" VALUE="0"/>
<PROPERTY NAME="dhcp_utilization" VALUE="0"/>
<PROPERTY NAME="v6_service_enable" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.member_dhcp_properties"/>
<PROPERTY NAME="service_enabled" VALUE="true"/>
<PROPERTY NAME="static_hosts" VALUE="50"/>
<PROPERTY NAME="dynamic_hosts" VALUE="200"/>
<PROPERTY NAME="total_hosts" VALUE="500"/>
<PROPERTY NAME="dhcp_utilization" VALUE="500"/>
<PROPERTY NAME="v6_service_enable" VALUE="false"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.physical_node"/>
<PROPERTY NAME="physical_oid" VALUE="P001"/>
<PROPERTY NAME="virtual_node" VALUE="101"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.physical_node"/>
<PROPERTY NAME="physical_oid" VALUE="P002"/>
<PROPERTY NAME="virtual_node" VALUE="102"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.product_license"/>
<PROPERTY NAME="pnode" VALUE="P001"/>
<PROPERTY NAME="license_type" VALUE="enterprise"/>
<PROPERTY NAME="license_kind" VALUE="STATIC"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.product_license"/>
<PROPERTY NAME="pnode" VALUE="P001"/>
<PROPERTY NAME="license_type" VALUE="dns"/>
<PROPERTY NAME="license_kind" VALUE="STATIC"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.product_license"/>
<PROPERTY NAME="pnode" VALUE="P001"/>
<PROPERTY NAME="license_type" VALUE="dhcp"/>
<PROPERTY NAME="license_kind" VALUE="STATIC"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.product_license"/>
<PROPERTY NAME="pnode" VALUE="P002"/>
<PROPERTY NAME="license_type" VALUE="enterprise"/>
<PROPERTY NAME="license_kind" VALUE="STATIC"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.product_license"/>
<PROPERTY NAME="pnode" VALUE="P002"/>
<PROPERTY NAME="license_type" VALUE="dns"/>
<PROPERTY NAME="license_kind" VALUE="STATIC"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.license_grid_wide"/>
<PROPERTY NAME="license_type" VALUE="rpz"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.license_grid_wide"/>
<PROPERTY NAME="license_type" VALUE="threat_anl"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.vnode_time"/>
<PROPERTY NAME="ntp_service_enabled" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.one.datacollector_cluster"/>
<PROPERTY NAME="enable_registration" VALUE="true"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.dhcp_member"/>
<PROPERTY NAME="network" VALUE="10.0.0.0/24/0"/>
<PROPERTY NAME="member" VALUE="101"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.dhcp_member"/>
<PROPERTY NAME="network" VALUE="10.0.1.0/24/0"/>
<PROPERTY NAME="member" VALUE="103"/>
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
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
<PROPERTY NAME="vnode_id" VALUE="103"/>
<PROPERTY NAME="binding_state" VALUE="active"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.20"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
<PROPERTY NAME="vnode_id" VALUE="103"/>
<PROPERTY NAME="binding_state" VALUE="expired"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.21"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.lease"/>
<PROPERTY NAME="vnode_id" VALUE="101"/>
<PROPERTY NAME="binding_state" VALUE="free"/>
<PROPERTY NAME="ip_address" VALUE="10.0.0.99"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="zone" VALUE="._default.local.test"/>
<PROPERTY NAME="fqdn" VALUE="test.local"/>
<PROPERTY NAME="assigned_ns_group" VALUE="primary-group"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.arpa"/>
<PROPERTY NAME="fqdn" VALUE="arpa.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.soa-only"/>
<PROPERTY NAME="fqdn" VALUE="soa-only.test.local"/>
<PROPERTY NAME="assigned_ns_group" VALUE="nonexistent-group"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.orphan"/>
<PROPERTY NAME="fqdn" VALUE="orphan.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.zone"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.gm-fallback"/>
<PROPERTY NAME="fqdn" VALUE="gm-fallback.test.local"/>
<PROPERTY NAME="assigned_ns_group" VALUE="another-nonexistent"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.bind_soa"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.soa-only"/>
<PROPERTY NAME="mname" VALUE="dns1.test.local."/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.bind_soa"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.orphan"/>
<PROPERTY NAME="mname" VALUE="dns1.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.bind_a"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.soa-only"/>
<PROPERTY NAME="name" VALUE="www"/>
<PROPERTY NAME="address" VALUE="192.168.1.1"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.bind_a"/>
<PROPERTY NAME="zone" VALUE="._default.local.test.orphan"/>
<PROPERTY NAME="name" VALUE="www"/>
<PROPERTY NAME="address" VALUE="192.168.2.1"/>
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
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.host_address"/>
<PROPERTY NAME="address" VALUE="10.99.1.100"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.network"/>
<PROPERTY NAME="address" VALUE="10.0.0.0"/>
<PROPERTY NAME="cidr" VALUE="24"/>
<PROPERTY NAME="network_view" VALUE="0"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.network"/>
<PROPERTY NAME="address" VALUE="10.0.1.0"/>
<PROPERTY NAME="cidr" VALUE="24"/>
<PROPERTY NAME="network_view" VALUE="0"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.network"/>
<PROPERTY NAME="address" VALUE="10.0.2.1"/>
<PROPERTY NAME="cidr" VALUE="32"/>
<PROPERTY NAME="network_view" VALUE="0"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.option"/>
<PROPERTY NAME="is_ipv4" VALUE="true"/>
<PROPERTY NAME="parent" VALUE=".com.infoblox.dns.network$10.0.0.0/24/0"/>
<PROPERTY NAME="option_definition" VALUE="DHCP..false.42"/>
<PROPERTY NAME="value" VALUE="10.0.0.1"/>
<PROPERTY NAME="ms_user_class" VALUE="."/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.option"/>
<PROPERTY NAME="is_ipv4" VALUE="true"/>
<PROPERTY NAME="parent" VALUE=".com.infoblox.dns.network$10.0.1.0/24/0"/>
<PROPERTY NAME="option_definition" VALUE="Cisco_AP..false.241"/>
<PROPERTY NAME="value" VALUE="10.0.1.99"/>
<PROPERTY NAME="ms_user_class" VALUE="."/>
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
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.host"/>
<PROPERTY NAME="fqdn" VALUE="server1.test.local"/>
<PROPERTY NAME="aliases" VALUE=""/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.host"/>
<PROPERTY NAME="fqdn" VALUE="server2.test.local"/>
<PROPERTY NAME="aliases" VALUE="alias1.test.local"/>
</OBJECT>
<OBJECT>
<PROPERTY NAME="__type" VALUE=".com.infoblox.dns.bind_dname"/>
<PROPERTY NAME="name" VALUE="alias.example.com"/>
<PROPERTY NAME="target" VALUE="target.example.com"/>
</OBJECT>
</DATABASE>
`

// TestGenerateMinimalFixture writes internal/scanner/nios/testdata/minimal.tar.gz.
// The file is a valid gzip+tar archive containing a single entry "onedb.xml" with
// 3 Grid Members (GM + DNS-only + DHCP-only), 1 ns_group_grid_primary, 2 dhcp_member
// objects, 6 leases, 5 DNS zones (with ns_group, SOA fallback, orphan, and GM fallback
// variants), 2 bind_soa objects (mname property, confirmed from Schneider backup),
// 2 bind_a records in SOA-fallback zones, 1 fixed address, 1 host address, 2 networks,
// 2 discovery_data objects, 1 idns_lbdn, and 2 host objects.
//
// The test is idempotent: if the file already exists it is overwritten to ensure
// the fixture stays in sync with this definition.
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
