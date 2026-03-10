// Package nios provides the NIOS backup scanner for Phase 10.
// roles.go maps Grid Member PROPERTY values from onedb.xml to service role strings.
package nios

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
	if props["is_grid_master"] == "true" {
		return "GM"
	}
	if props["is_candidate_master"] == "true" {
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
