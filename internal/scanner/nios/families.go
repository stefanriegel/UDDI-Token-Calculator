// Package nios provides the NIOS backup scanner for Phase 10.
// families.go defines XML type-to-family mappings and family classification sets.
package nios

// NiosFamily constants identify each class of NIOS DDI object parsed from onedb.xml.
// Values are lowercase strings matching the Python _families.py reference implementation.
const (
	NiosFamilyLease            = "lease"
	NiosFamilyDNSRecordA       = "dns_record_a"
	NiosFamilyDNSRecordAAAA    = "dns_record_aaaa"
	NiosFamilyDNSRecordCNAME   = "dns_record_cname"
	NiosFamilyDNSRecordMX      = "dns_record_mx"
	NiosFamilyDNSRecordNS      = "dns_record_ns"
	NiosFamilyDNSRecordPTR     = "dns_record_ptr"
	NiosFamilyDNSRecordSOA     = "dns_record_soa"
	NiosFamilyDNSRecordSRV     = "dns_record_srv"
	NiosFamilyDNSRecordTXT     = "dns_record_txt"
	NiosFamilyHostAddress      = "host_address"
	NiosFamilyHostObject       = "host_object"
	NiosFamilyHostAlias        = "host_alias"
	NiosFamilyNetwork          = "network"
	NiosFamilyFixedAddress     = "fixed_address"
	NiosFamilyDHCPRange        = "dhcp_range"
	NiosFamilyExclusionRange   = "exclusion_range"
	NiosFamilyNetworkContainer = "network_container"
	NiosFamilyNetworkView      = "network_view"
	NiosFamilyDNSZone          = "dns_zone"
	NiosFamilyMember           = "member"
	NiosFamilyDTCLBDN          = "dtc_lbdn"
	NiosFamilyDTCPool          = "dtc_pool"
	NiosFamilyDTCServer        = "dtc_server"
	NiosFamilyDTCMonitor       = "dtc_monitor"
	NiosFamilyDTCTopology      = "dtc_topology"
)

// XMLTypeToFamily maps the __type PROPERTY VALUE strings found in onedb.xml
// to the corresponding NiosFamily constant. Derived from empirical ZF backup
// analysis and the Python _families.py reference implementation.
var XMLTypeToFamily = map[string]string{
	".com.infoblox.dns.lease":             NiosFamilyLease,
	".com.infoblox.dns.bind_ptr":          NiosFamilyDNSRecordPTR,
	".com.infoblox.dns.bind_a":            NiosFamilyDNSRecordA,
	".com.infoblox.dns.bind_txt":          NiosFamilyDNSRecordTXT,
	".com.infoblox.dns.bind_srv":          NiosFamilyDNSRecordSRV,
	".com.infoblox.dns.bind_soa":          NiosFamilyDNSRecordSOA,
	".com.infoblox.dns.bind_cname":        NiosFamilyDNSRecordCNAME,
	".com.infoblox.dns.bind_aaaa":         NiosFamilyDNSRecordAAAA,
	".com.infoblox.dns.bind_mx":           NiosFamilyDNSRecordMX,
	".com.infoblox.dns.bind_ns":           NiosFamilyDNSRecordNS,
	".com.infoblox.dns.host_address":      NiosFamilyHostAddress,
	".com.infoblox.dns.host":              NiosFamilyHostObject,
	".com.infoblox.dns.network":           NiosFamilyNetwork,
	".com.infoblox.dns.fixed_address":     NiosFamilyFixedAddress,
	".com.infoblox.dns.host_alias":        NiosFamilyHostAlias,
	".com.infoblox.dns.dhcp_range":        NiosFamilyDHCPRange,
	".com.infoblox.dns.network_container": NiosFamilyNetworkContainer,
	".com.infoblox.dns.exclusion_range":   NiosFamilyExclusionRange,
	".com.infoblox.dns.zone":              NiosFamilyDNSZone,
	".com.infoblox.dns.network_view":      NiosFamilyNetworkView,
	".com.infoblox.one.virtual_node":      NiosFamilyMember,

	// DTC types — spec-derived, unverified — no empirical backup observed.
	".com.infoblox.dns.dtc.lbdn":     NiosFamilyDTCLBDN,
	".com.infoblox.dns.dtc.pool":     NiosFamilyDTCPool,
	".com.infoblox.dns.dtc.server":   NiosFamilyDTCServer,
	".com.infoblox.dns.dtc.monitor":  NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc.topology": NiosFamilyDTCTopology,
}

// MemberXMLTypes is the set of __type values that identify Grid Member objects
// (virtual_node). Used in pass 1 to build the vnode_id → hostname map.
var MemberXMLTypes = map[string]struct{}{
	".com.infoblox.one.virtual_node": {},
}

// DDIFamilies is the set of NiosFamily values that contribute to the DDI Objects count.
// Matches _DDI_FAMILIES from the Python counter.py reference implementation.
// LEASE is NOT in DDIFamilies — it contributes to Active IPs only.
var DDIFamilies = map[string]struct{}{
	NiosFamilyDNSRecordA:       {},
	NiosFamilyDNSRecordAAAA:    {},
	NiosFamilyDNSRecordCNAME:   {},
	NiosFamilyDNSRecordMX:      {},
	NiosFamilyDNSRecordNS:      {},
	NiosFamilyDNSRecordPTR:     {},
	NiosFamilyDNSRecordSOA:     {},
	NiosFamilyDNSRecordSRV:     {},
	NiosFamilyDNSRecordTXT:     {},
	NiosFamilyHostObject:       {},
	NiosFamilyHostAlias:        {},
	NiosFamilyDNSZone:          {},
	NiosFamilyDHCPRange:        {},
	NiosFamilyExclusionRange:   {},
	NiosFamilyNetwork:          {},
	NiosFamilyNetworkContainer: {},
	NiosFamilyNetworkView:      {},
	NiosFamilyDTCLBDN:          {},
	NiosFamilyDTCPool:          {},
	NiosFamilyDTCServer:        {},
	NiosFamilyDTCMonitor:       {},
	NiosFamilyDTCTopology:      {},
}

// MemberScopedFamilies is the set of families whose objects carry a vnode_id
// attribute that links them to a specific Grid Member. Only LEASE objects have
// vnode_id in the ZF reference backup — all other families are grid-level.
var MemberScopedFamilies = map[string]struct{}{
	NiosFamilyLease: {},
}
