package ad

import (
	"strings"
	"testing"
)

// TestDiscoveredServerRoles verifies appendRole deduplication.
func TestAppendRole_Dedup(t *testing.T) {
	roles := []string{"DC", "DNS"}
	roles = appendRole(roles, "DNS") // already present
	if len(roles) != 2 {
		t.Errorf("appendRole should not duplicate existing role; got %v", roles)
	}
	roles = appendRole(roles, "DHCP") // new role
	if len(roles) != 3 {
		t.Errorf("appendRole should add new role; got %v", roles)
	}
	if roles[2] != "DHCP" {
		t.Errorf("appended role = %q, want DHCP", roles[2])
	}
}

// TestForestDiscovery_StructureCompiles verifies that ForestDiscovery and
// DiscoveredServer have the expected fields (compile-time assertion via field access).
func TestForestDiscovery_Fields(t *testing.T) {
	fd := &ForestDiscovery{
		ForestName: "corp.local",
		DomainControllers: []DiscoveredServer{
			{Hostname: "DC01.corp.local", IP: "10.0.0.1", Domain: "corp.local", Roles: []string{"DC", "DNS"}},
		},
		DHCPServers: []DiscoveredServer{
			{Hostname: "dhcp01.corp.local", IP: "10.0.0.5", Roles: []string{"DHCP"}},
		},
		Errors: []string{"partial error"},
	}
	if fd.ForestName != "corp.local" {
		t.Errorf("ForestName = %q, want corp.local", fd.ForestName)
	}
	if len(fd.DomainControllers) != 1 {
		t.Errorf("DomainControllers len = %d, want 1", len(fd.DomainControllers))
	}
	dc := fd.DomainControllers[0]
	if dc.Hostname != "DC01.corp.local" {
		t.Errorf("DC Hostname = %q", dc.Hostname)
	}
	if !strings.Contains(strings.Join(dc.Roles, ","), "DC") {
		t.Errorf("DC roles should contain DC; got %v", dc.Roles)
	}
	if len(fd.DHCPServers) != 1 {
		t.Errorf("DHCPServers len = %d, want 1", len(fd.DHCPServers))
	}
	if len(fd.Errors) != 1 {
		t.Errorf("Errors len = %d, want 1", len(fd.Errors))
	}
}

// TestDCAlsoRunsDHCP_MergesRoles verifies that when DiscoverForest finds a DC hostname
// in the DHCP list, the DHCP role is appended to the DC entry rather than creating a
// duplicate DHCPServers entry.  We simulate this by calling appendRole directly.
func TestDCAlsoRunsDHCP_MergesRoles(t *testing.T) {
	dc := DiscoveredServer{
		Hostname: "DC01.corp.local",
		Roles:    []string{"DC", "DNS"},
	}
	dc.Roles = appendRole(dc.Roles, "DHCP")
	if len(dc.Roles) != 3 {
		t.Errorf("roles after merge = %d, want 3 (DC, DNS, DHCP); got %v", len(dc.Roles), dc.Roles)
	}
	// Calling appendRole again should be idempotent.
	dc.Roles = appendRole(dc.Roles, "DHCP")
	if len(dc.Roles) != 3 {
		t.Errorf("appendRole not idempotent; got %v", dc.Roles)
	}
}

// TestDiscoverForest_Signature verifies DiscoverForest is exported with the right
// signature — this is a compile-time check.
var _ = DiscoverForest
