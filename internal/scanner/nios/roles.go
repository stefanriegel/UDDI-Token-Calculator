// Package nios provides the NIOS backup scanner for Phase 10.
// roles.go maps Grid Member PROPERTY values from onedb.xml to service role strings.
package nios

// GridMember is the minimal member record extracted from a NIOS backup during upload.
// It is used by the server upload handler to return member hostnames and roles to the
// frontend without coupling the server package to scanner internals.
type GridMember struct {
	Hostname string
	Role     string
}

// vnodeMemberTypes is the type-filter set for the upload member scan.
// We only need virtual_node objects — no resolver data (ns_group etc.) required here.
var vnodeMemberTypes = map[string]struct{}{
	".com.infoblox.one.virtual_node": {},
}

// StreamMembers opens a NIOS backup file (raw onedb.xml or gzip+tar archive),
// extracts all Grid Member records using the fast byte-level parser, and returns
// them sorted by hostname. This is used by the upload handler to populate the
// member-selection UI without re-running the full two-pass scan.
//
// The path may point to a pre-extracted onedb.xml (the common case after upload)
// or a gzip+tar archive (test fixtures). Format is auto-detected.
func StreamMembers(path string) ([]GridMember, error) {
	var members []GridMember
	err := streamOnedbXMLFiltered(path, vnodeMemberTypes, func(props map[string]string) {
		hostname := props["host_name"]
		if hostname == "" {
			return
		}
		members = append(members, GridMember{
			Hostname: hostname,
			Role:     extractServiceRole(props),
		})
	})
	return members, err
}

// ExportedExtractServiceRole is the exported form of extractServiceRole for use by
// server/scan.go (which cannot access unexported package functions).
// Returns the same service role string as extractServiceRole.
func ExportedExtractServiceRole(props map[string]string) string {
	return extractServiceRole(props)
}

// extractServiceRole returns a human-readable role string for a Grid Member based
// on the PROPERTY map parsed from its virtual_node OBJECT in onedb.xml.
//
// Role precedence (highest to lowest):
//  1. Structural master roles (is_grid_master, is_candidate_master)
//  2. Service flag combinations (enable_dns, enable_dhcp, enable_reporting, enable_ipam)
//  3. Default fallback to "DNS/DHCP" (safe default for members with unrecognized flags)
//
// Note: onedb.xml property names vary by NIOS version. The enable_* flags documented
// here are the canonical form from NIOS 8.x/9.x. Earlier versions may use different
// keys. The fallback default "DNS/DHCP" is intentionally conservative.
func extractServiceRole(props map[string]string) string {
	// Structural master roles take precedence over service flags.
	if props["is_master"] == "true" || props["is_grid_master"] == "true" {
		return "GM"
	}
	if props["is_potential_master"] == "true" || props["is_candidate_master"] == "true" {
		return "GMC"
	}

	// Service flag detection.
	hasDNS := props["enable_dns"] == "true"
	hasDHCP := props["enable_dhcp"] == "true"
	hasReporting := props["enable_reporting"] == "true"
	hasIPAM := props["enable_ipam"] == "true"

	switch {
	case hasDNS && hasDHCP:
		return "DNS/DHCP"
	case hasDNS:
		return "DNS"
	case hasDHCP:
		return "DHCP"
	case hasReporting:
		return "Reporting"
	case hasIPAM:
		return "IPAM"
	default:
		// No recognized service flags — default to DNS/DHCP.
		// This covers NIOS versions with different property names and
		// members that serve all roles without explicit enable_* flags.
		return "DNS/DHCP"
	}
}
