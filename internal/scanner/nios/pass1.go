package nios

import "strings"

// physicalNodeInfo holds the deferred physical_node → virtual_node linkage data.
// physical_node objects often appear before virtual_node objects in onedb.xml,
// so the linkage must be applied after the streaming pass completes.
type physicalNodeInfo struct {
	vnodeRef   string
	hwtype     string
	hwplatform string
}

// pass1State accumulates everything Pass 1 needs to extract from onedb.xml in a
// single streaming pass: member identity, resolver inputs (ns_group, dhcp_member,
// zone, SOA), positional service properties, license inventory, and grid-level
// feature flags.
type pass1State struct {
	// Member identity.
	vnodeMap    map[string]string            // vnode_id → hostname
	memberProps map[string]map[string]string // hostname → cloned props
	gmHostname  string

	// Resolver inputs.
	nsGroupPrimary map[string]string // ns_group → member oid (authoritative primary)
	nsGroupForward map[string]string // ns_group → member oid (forward zone forwarder)
	dhcpMembers    map[string]string // network key → member oid
	zoneNSGroup    map[string]string // zone ref → ns_group name
	allZoneRefs    map[string]string // zone ref → ns_group name (empty if none)
	soaPrimaryMap  map[string]string // zone ref → primary nameserver FQDN

	// Ordered slices for positional matching against member_dns_properties /
	// member_dhcp_properties (which appear in the same order as virtual_node).
	vnodeOrder         []string
	dnsServiceEnabled  []string
	dhcpServiceEnabled []string
	dhcpStaticHosts    []string
	dhcpDynamicHosts   []string
	dhcpTotalHosts     []string
	dhcpUtilization    []string

	// License inventory.
	pnodeLicenses    map[string][]string // physical_oid → license types
	gridLicenseTypes []string
	pnodeVnodeMap    map[string]string // physical_oid → virtual_node ref

	// Feature flags (grid-wide). DNAMERecords is set in Pass 2.
	gridFeatures NiosGridFeatures

	// Linkage deferred until the pass completes.
	deferredPhysicalNodes []physicalNodeInfo
}

func newPass1State() *pass1State {
	return &pass1State{
		vnodeMap:       make(map[string]string),
		memberProps:    make(map[string]map[string]string),
		nsGroupPrimary: make(map[string]string),
		nsGroupForward: make(map[string]string),
		dhcpMembers:    make(map[string]string),
		zoneNSGroup:    make(map[string]string),
		allZoneRefs:    make(map[string]string),
		soaPrimaryMap:  make(map[string]string),
		pnodeLicenses:  make(map[string][]string),
		pnodeVnodeMap:  make(map[string]string),
	}
}

// record dispatches a single XML object to the appropriate handler based on its
// __type. Designed to be passed directly to streamOnedbXMLFiltered.
func (p *pass1State) record(props map[string]string) {
	switch props["__type"] {
	case ".com.infoblox.one.virtual_node":
		p.recordVirtualNode(props)
	case ".com.infoblox.one.physical_node":
		p.recordPhysicalNode(props)
	case ".com.infoblox.dns.member_dns_properties":
		p.recordMemberDNS(props)
	case ".com.infoblox.dns.member_dhcp_properties":
		p.recordMemberDHCP(props)
	case ".com.infoblox.one.product_license":
		p.recordProductLicense(props)
	case ".com.infoblox.one.license_grid_wide":
		if licType := props["license_type"]; licType != "" {
			p.gridLicenseTypes = append(p.gridLicenseTypes, licType)
		}
	case ".com.infoblox.one.vnode_time":
		if props["ntp_service_enabled"] == "true" {
			p.gridFeatures.NTPServer = true
		}
	case ".com.infoblox.one.datacollector_cluster":
		if props["enable_registration"] == "true" {
			p.gridFeatures.DataConnector = true
		}
	case ".com.infoblox.dns.ns_group_grid_primary":
		p.recordNSGroupPrimary(props)
	case ".com.infoblox.dns.ns_group_forwarding_server":
		p.recordNSGroupForward(props)
	case ".com.infoblox.dns.dhcp_member":
		p.recordDHCPMember(props)
	case ".com.infoblox.dns.zone":
		p.recordZone(props)
	case ".com.infoblox.dns.bind_soa":
		p.recordBindSOA(props)
	}
}

func (p *pass1State) recordVirtualNode(props map[string]string) {
	oid := props["virtual_oid"]
	hostname := props["host_name"]
	if oid == "" || hostname == "" {
		return
	}
	p.vnodeMap[oid] = hostname
	p.vnodeOrder = append(p.vnodeOrder, hostname)
	cloned := make(map[string]string, len(props))
	for k, v := range props {
		cloned[k] = v
	}
	p.memberProps[hostname] = cloned
	if props["is_master"] == "true" || props["is_grid_master"] == "true" {
		p.gmHostname = hostname
	}
}

func (p *pass1State) recordPhysicalNode(props map[string]string) {
	hwtype := props["hwtype"]
	hwplatform := props["hwplatform"]
	vnodeRef := props["virtual_node"]
	// Defer physical_node → virtual_node linkage: in real NIOS backups,
	// physical_node objects often appear before virtual_node objects in the
	// XML stream, so vnodeMap may not be populated yet.
	if vnodeRef != "" && (hwtype != "" || hwplatform != "") {
		p.deferredPhysicalNodes = append(p.deferredPhysicalNodes, physicalNodeInfo{
			vnodeRef:   vnodeRef,
			hwtype:     hwtype,
			hwplatform: hwplatform,
		})
	}
	if physicalOID := props["physical_oid"]; physicalOID != "" && vnodeRef != "" {
		p.pnodeVnodeMap[physicalOID] = vnodeRef
	}
}

func (p *pass1State) recordMemberDNS(props map[string]string) {
	p.dnsServiceEnabled = append(p.dnsServiceEnabled, props["service_enabled"])
	if props["enable_anycast"] == "true" || props["anycast_enabled"] == "true" {
		p.gridFeatures.DNSAnycast = true
	}
}

func (p *pass1State) recordMemberDHCP(props map[string]string) {
	p.dhcpServiceEnabled = append(p.dhcpServiceEnabled, props["service_enabled"])
	p.dhcpStaticHosts = append(p.dhcpStaticHosts, props["static_hosts"])
	p.dhcpDynamicHosts = append(p.dhcpDynamicHosts, props["dynamic_hosts"])
	p.dhcpTotalHosts = append(p.dhcpTotalHosts, props["total_hosts"])
	p.dhcpUtilization = append(p.dhcpUtilization, props["dhcp_utilization"])
	if props["v6_service_enable"] == "true" {
		p.gridFeatures.DHCPv6 = true
	}
}

func (p *pass1State) recordProductLicense(props map[string]string) {
	pnode := props["pnode"]
	licType := props["license_type"]
	if pnode != "" && licType != "" {
		p.pnodeLicenses[pnode] = append(p.pnodeLicenses[pnode], licType)
	}
}

func (p *pass1State) recordNSGroupPrimary(props map[string]string) {
	nsGroup := props["ns_group"]
	memberOID := props["grid_member"]
	if nsGroup == "" || memberOID == "" {
		return
	}
	if _, exists := p.nsGroupPrimary[nsGroup]; !exists {
		p.nsGroupPrimary[nsGroup] = memberOID
	}
}

func (p *pass1State) recordNSGroupForward(props map[string]string) {
	// Forward zones identify their responsible member via forward_address (member OID),
	// not grid_member. Collect the first occurrence per ns_group as the primary forwarder.
	nsGroup := props["ns_group"]
	memberOID := props["forward_address"]
	if nsGroup == "" || memberOID == "" {
		return
	}
	if _, exists := p.nsGroupForward[nsGroup]; !exists {
		p.nsGroupForward[nsGroup] = memberOID
	}
}

func (p *pass1State) recordDHCPMember(props map[string]string) {
	network := props["network"]
	memberOID := props["member"]
	if network == "" || memberOID == "" {
		return
	}
	if _, exists := p.dhcpMembers[network]; !exists {
		p.dhcpMembers[network] = memberOID
	}
}

func (p *pass1State) recordZone(props map[string]string) {
	zoneRef := props["zone"]
	if zoneRef == "" {
		return
	}
	nsGroup := props["assigned_ns_group"]
	p.allZoneRefs[zoneRef] = nsGroup
	if nsGroup != "" {
		p.zoneNSGroup[zoneRef] = nsGroup
	}
}

func (p *pass1State) recordBindSOA(props map[string]string) {
	// SOA records identify the primary nameserver for a zone via the "mname" property.
	zoneRef := props["zone"]
	primaryNS := props["mname"]
	if zoneRef == "" || primaryNS == "" {
		return
	}
	// Normalize: trim trailing dot, lowercase (DNS convention).
	primaryNS = strings.TrimSuffix(strings.ToLower(primaryNS), ".")
	p.soaPrimaryMap[zoneRef] = primaryNS
}

// finalize runs the cleanup steps that depend on a fully-populated state:
// deferred physical_node linkage, positional dns/dhcp property merging, and
// the gmHostname fallback to the first member when no is_master flag is set.
func (p *pass1State) finalize() {
	// Apply deferred physical_node linkage now that vnodeMap is fully populated.
	for _, pn := range p.deferredPhysicalNodes {
		hostname, ok := p.vnodeMap[pn.vnodeRef]
		if !ok {
			continue
		}
		mp := p.memberProps[hostname]
		if mp == nil {
			continue
		}
		mp["_hwtype"] = pn.hwtype
		mp["_hwplatform"] = pn.hwplatform
	}

	// Merge positional dns/dhcp service properties into memberProps.
	// member_dns_properties and member_dhcp_properties appear in the same order
	// as virtual_node objects.
	for i, hostname := range p.vnodeOrder {
		mp := p.memberProps[hostname]
		if mp == nil {
			continue
		}
		if i < len(p.dnsServiceEnabled) {
			mp["enable_dns"] = p.dnsServiceEnabled[i]
		}
		if i < len(p.dhcpServiceEnabled) {
			mp["enable_dhcp"] = p.dhcpServiceEnabled[i]
		}
		if i < len(p.dhcpStaticHosts) {
			mp["_static_hosts"] = p.dhcpStaticHosts[i]
		}
		if i < len(p.dhcpDynamicHosts) {
			mp["_dynamic_hosts"] = p.dhcpDynamicHosts[i]
		}
		if i < len(p.dhcpTotalHosts) {
			mp["_total_hosts"] = p.dhcpTotalHosts[i]
		}
		if i < len(p.dhcpUtilization) {
			mp["_dhcp_utilization"] = p.dhcpUtilization[i]
		}
	}

	// gmHostname fallback: if is_master was not found in any member,
	// use the first member hostname from vnodeMap.
	if p.gmHostname == "" && len(p.vnodeMap) > 0 {
		for _, h := range p.vnodeMap {
			p.gmHostname = h
			break
		}
	}
}

// buildResolver constructs a memberResolver from the pass1State using the three-tier
// zone resolution: ns_group → SOA mname → Grid Master fallback. networkMemberMap is
// resolved directly from dhcp_member objects.
func (p *pass1State) buildResolver() *memberResolver {
	// Build hostname lookup for SOA mname matching (lowercase normalized).
	hostnameLookup := make(map[string]string, len(p.vnodeMap))
	for _, hostname := range p.vnodeMap {
		hostnameLookup[strings.ToLower(hostname)] = hostname
	}

	zoneMemberMap := make(map[string]string, len(p.allZoneRefs))

	// Tier 1: resolve via ns_group.
	for zoneRef, nsGroup := range p.zoneNSGroup {
		memberOID := p.nsGroupPrimary[nsGroup]
		if memberOID == "" {
			memberOID = p.nsGroupForward[nsGroup]
		}
		if memberOID == "" {
			continue
		}
		if hostname, ok := p.vnodeMap[memberOID]; ok {
			zoneMemberMap[zoneRef] = hostname
		}
	}

	// Tier 2: SOA fallback for unresolved zones (including zones without ns_group).
	// Tier 3: Grid Master fallback (D-01).
	for zoneRef := range p.allZoneRefs {
		if _, resolved := zoneMemberMap[zoneRef]; resolved {
			continue
		}
		if soaMname, ok := p.soaPrimaryMap[zoneRef]; ok {
			normalized := strings.TrimSuffix(strings.ToLower(soaMname), ".")
			if hostname, ok := hostnameLookup[normalized]; ok {
				zoneMemberMap[zoneRef] = hostname
				continue
			}
		}
		zoneMemberMap[zoneRef] = p.gmHostname
	}

	networkMemberMap := make(map[string]string, len(p.dhcpMembers))
	for network, memberOID := range p.dhcpMembers {
		if hostname, ok := p.vnodeMap[memberOID]; ok {
			networkMemberMap[network] = hostname
		}
	}

	return &memberResolver{
		zoneMemberMap:    zoneMemberMap,
		networkMemberMap: networkMemberMap,
		cidrEntries:      buildCIDREntries(networkMemberMap),
	}
}

// buildLicensesByMember resolves the product_license → physical_node → virtual_node
// chain into a per-member set of license types.
func (p *pass1State) buildLicensesByMember() map[string]map[string]bool {
	memberLicenses := make(map[string]map[string]bool)
	for physOID, licTypes := range p.pnodeLicenses {
		vnodeRef := p.pnodeVnodeMap[physOID]
		if vnodeRef == "" {
			continue
		}
		hostname, ok := p.vnodeMap[vnodeRef]
		if !ok {
			continue
		}
		if memberLicenses[hostname] == nil {
			memberLicenses[hostname] = make(map[string]bool)
		}
		for _, lt := range licTypes {
			memberLicenses[hostname][lt] = true
		}
	}
	return memberLicenses
}
