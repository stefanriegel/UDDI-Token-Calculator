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
	NiosFamilyDNSRecordCAA     = "dns_record_caa"
	NiosFamilyDNSRecordNAPTR   = "dns_record_naptr"
	NiosFamilyDNSRecordHTTPS   = "dns_record_https"
	NiosFamilyDNSRecordSVCB    = "dns_record_svcb"
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
	NiosFamilyDiscoveryData      = "discovery_data"
	NiosFamilyDNSRecordAlias     = "dns_record_alias"
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
	".com.infoblox.dns.bind_caa":          NiosFamilyDNSRecordCAA,
	".com.infoblox.dns.bind_naptr":        NiosFamilyDNSRecordNAPTR,
	".com.infoblox.dns.bind_https":        NiosFamilyDNSRecordHTTPS,
	".com.infoblox.dns.bind_svcb":         NiosFamilyDNSRecordSVCB,
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

	// DNS alias record — similar to CNAME, counts as DDI.
	".com.infoblox.dns.alias_record": NiosFamilyDNSRecordAlias,

	// Discovery data — Active IP source (not DDI, not member-scoped).
	".com.infoblox.dns.discovery_data": NiosFamilyDiscoveryData,

	// DTC types — spec-derived, unverified — no empirical backup observed.
	// Uses underscore format matching Python reference implementation.
	".com.infoblox.dns.dtc_lbdn":     NiosFamilyDTCLBDN,
	".com.infoblox.dns.dtc_pool":     NiosFamilyDTCPool,
	".com.infoblox.dns.dtc_server":   NiosFamilyDTCServer,
	".com.infoblox.dns.dtc_monitor":  NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc_topology": NiosFamilyDTCTopology,

	// DTC monitor subtypes — spec-derived.
	".com.infoblox.dns.dtc_monitor_http": NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc_monitor_icmp": NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc_monitor_pdp":  NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc_monitor_sip":  NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc_monitor_snmp": NiosFamilyDTCMonitor,
	".com.infoblox.dns.dtc_monitor_tcp":  NiosFamilyDTCMonitor,

	// DTC topology subtypes — spec-derived.
	".com.infoblox.dns.dtc_topology_label": NiosFamilyDTCTopology,
	".com.infoblox.dns.dtc_topology_rule":  NiosFamilyDTCTopology,

	// DTC types via older iDNS namespace — real backups (e.g. ZF) use idns_*
	// while the spec uses dns.dtc_*. Support both prefixes.
	".com.infoblox.one.idns_lbdn":           NiosFamilyDTCLBDN,
	".com.infoblox.one.idns_pool":           NiosFamilyDTCPool,
	".com.infoblox.one.idns_server":         NiosFamilyDTCServer,
	".com.infoblox.one.idns_topology_label": NiosFamilyDTCTopology,
	".com.infoblox.one.idns_topology_rule":  NiosFamilyDTCTopology,
	// idns_monitor_* (one.* and dns.*) are health-check template definitions, not
	// per-pool monitor instances. The reference tool counts only idns_pool_monitor
	// as LBDN_Server_Monitor. Template types excluded here.
	// Also support dns.idns_* prefix variant.
	".com.infoblox.dns.idns_lbdn":           NiosFamilyDTCLBDN,
	".com.infoblox.dns.idns_pool":           NiosFamilyDTCPool,
	".com.infoblox.dns.idns_server":         NiosFamilyDTCServer,
	".com.infoblox.dns.idns_topology_label": NiosFamilyDTCTopology,
	".com.infoblox.dns.idns_topology_rule":    NiosFamilyDTCTopology,
	".com.infoblox.dns.idns_pool_monitor":     NiosFamilyDTCMonitor,
	// Note: idns_monitor_http/tcp/icmp/pdp/sip/snmp/auth_parent are DTC health-check
	// template definitions, not per-pool monitor instances. The reference XLS counts
	// only idns_pool_monitor as LBDN_Server_Monitor. These template types are excluded.
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
	NiosFamilyDNSRecordCAA:     {},
	NiosFamilyDNSRecordNAPTR:   {},
	NiosFamilyDNSRecordHTTPS:   {},
	NiosFamilyDNSRecordSVCB:    {},
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
	NiosFamilyDNSRecordAlias:   {},
}

// MemberScopedFamilies is the set of families whose objects carry a vnode_id
// attribute that links them to a specific Grid Member. Only LEASE objects have
// vnode_id in the ZF reference backup — all other families are grid-level.
var MemberScopedFamilies = map[string]struct{}{
	NiosFamilyLease: {},
}
