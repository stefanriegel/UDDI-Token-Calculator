package nios

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// TestCustomerBackupRoles parses real customer NIOS backups through Pass 1 logic
// and reports per-member role detection results for visual verification.
//
// This is an exploratory test: it does NOT assert specific role values (we don't
// know correct answers). It only asserts that parsing succeeded and at least 1
// member was found per available backup.
//
// Run: go test ./internal/scanner/nios/ -run TestCustomerBackupRoles -v -count=1
func TestCustomerBackupRoles(t *testing.T) {
	type backup struct {
		name string
		path string
	}

	backups := []backup{
		{"Stadtwerke_Bielefeld", "/Users/mustermann/Downloads/Stadtwerke_Bielefeld_9.0.5.bak"},
		{"PROD_DMZ", "/Users/mustermann/Downloads/database_PROD_DMZ.bak"},
		{"csnfxx67_NBU", "/Users/mustermann/Downloads/csnfxx67-NBU-database.bak"},
		{"ZF", "/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/do_not_commit/ZF-database-03-2026.bak"},
		{"database", "/Users/mustermann/Documents/coding/Infoblox-Universal-DDI-cloud-usage/do_not_commit/database.bak"},
	}

	// Summary tracking across all backups.
	type summaryRow struct {
		name             string
		members          int
		dnsPropsCount    int
		dhcpPropsCount   int
		positionalMatch  string
		roleCounts       map[string]int
	}
	var summaryRows []summaryRow

	for _, bk := range backups {
		t.Run(bk.name, func(t *testing.T) {
			if _, err := os.Stat(bk.path); err != nil {
				t.Skipf("Backup file not available: %s", bk.path)
				return
			}

			// Replicate Pass 1 logic from scanner.go.
			vnodeMap := make(map[string]string)              // vnode_id -> hostname
			memberProps := make(map[string]map[string]string) // hostname -> props
			var vnodeOrder []string
			var dnsServiceEnabled []string
			var dhcpServiceEnabled []string

			err := streamOnedbXMLFiltered(bk.path, pass1Types, func(props map[string]string) {
				xmlType := props["__type"]
				switch xmlType {
				case ".com.infoblox.one.virtual_node":
					oid := props["virtual_oid"]
					hostname := props["host_name"]
					if oid == "" || hostname == "" {
						return
					}
					vnodeMap[oid] = hostname
					vnodeOrder = append(vnodeOrder, hostname)
					cloned := make(map[string]string, len(props))
					for k, v := range props {
						cloned[k] = v
					}
					memberProps[hostname] = cloned

				case ".com.infoblox.dns.member_dns_properties":
					dnsServiceEnabled = append(dnsServiceEnabled, props["service_enabled"])

				case ".com.infoblox.dns.member_dhcp_properties":
					dhcpServiceEnabled = append(dhcpServiceEnabled, props["service_enabled"])
				}
			})
			if err != nil {
				t.Fatalf("Pass 1 parsing failed: %v", err)
			}

			if len(vnodeMap) == 0 {
				t.Fatalf("No members found in backup %s", bk.name)
			}

			// Merge dns/dhcp service properties by positional correspondence.
			for i, hostname := range vnodeOrder {
				props := memberProps[hostname]
				if props == nil {
					continue
				}
				if i < len(dnsServiceEnabled) {
					props["enable_dns"] = dnsServiceEnabled[i]
				}
				if i < len(dhcpServiceEnabled) {
					props["enable_dhcp"] = dhcpServiceEnabled[i]
				}
			}

			// Determine positional match status.
			positionalMatch := "OK (all counts equal)"
			if len(vnodeOrder) != len(dnsServiceEnabled) || len(vnodeOrder) != len(dhcpServiceEnabled) {
				positionalMatch = fmt.Sprintf("MISMATCH (vnodes=%d, dns_props=%d, dhcp_props=%d)",
					len(vnodeOrder), len(dnsServiceEnabled), len(dhcpServiceEnabled))
			}

			// Print header.
			t.Logf("")
			t.Logf("=== Backup: %s ===", bk.name)
			t.Logf("Members found: %d", len(vnodeOrder))
			t.Logf("member_dns_properties count: %d", len(dnsServiceEnabled))
			t.Logf("member_dhcp_properties count: %d", len(dhcpServiceEnabled))
			t.Logf("Positional match: %s", positionalMatch)
			t.Logf("")

			// Print per-member roles.
			t.Logf("Member Roles:")

			roleCounts := map[string]int{}
			relevantKeys := []string{
				"is_master", "is_grid_master", "is_potential_master", "is_candidate_master",
				"enable_dns", "enable_dhcp", "enable_reporting", "enable_ipam",
			}

			for _, hostname := range vnodeOrder {
				props := memberProps[hostname]
				role := extractServiceRole(props)
				roleCounts[role]++

				// Build raw props display.
				var rawParts []string
				for _, key := range relevantKeys {
					if val, ok := props[key]; ok {
						rawParts = append(rawParts, fmt.Sprintf("%s=%s", key, val))
					}
				}
				rawDisplay := strings.Join(rawParts, ", ")
				if rawDisplay == "" {
					rawDisplay = "(no relevant props)"
				}

				t.Logf("  %-45s -> %-10s (%s)", hostname, role, rawDisplay)
			}

			// Track for summary.
			summaryRows = append(summaryRows, summaryRow{
				name:            bk.name,
				members:         len(vnodeOrder),
				dnsPropsCount:   len(dnsServiceEnabled),
				dhcpPropsCount:  len(dhcpServiceEnabled),
				positionalMatch: positionalMatch,
				roleCounts:      roleCounts,
			})
		})
	}

	// Print summary table.
	if len(summaryRows) > 0 {
		t.Logf("")
		t.Logf("=== SUMMARY ===")
		t.Logf("%-25s %7s %4s %4s %4s %5s %9s %6s  %s",
			"Backup", "Members", "GM", "GMC", "DNS", "DHCP", "DNS/DHCP", "Other", "Positional Match")

		for _, row := range summaryRows {
			otherCount := 0
			knownRoles := map[string]bool{"GM": true, "GMC": true, "DNS": true, "DHCP": true, "DNS/DHCP": true}
			for role, count := range row.roleCounts {
				if !knownRoles[role] {
					otherCount += count
				}
			}

			t.Logf("%-25s %7d %4d %4d %4d %5d %9d %6d  %s",
				row.name,
				row.members,
				row.roleCounts["GM"],
				row.roleCounts["GMC"],
				row.roleCounts["DNS"],
				row.roleCounts["DHCP"],
				row.roleCounts["DNS/DHCP"],
				otherCount,
				row.positionalMatch,
			)
		}
	}
}
