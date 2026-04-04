// Package nios provides the NIOS backup scanner for Phase 10.
// counter.go defines the per-member accumulator and object counting logic.
// No file I/O or XML streaming here — this is pure business logic tested in isolation.
//
// Counting model:
//   - DDI objects are attributed to members where possible via memberResolver.
//     DNS records resolve via zone → ns_group → member. DHCP objects resolve via
//     dhcp_member or the range's member property. Unresolvable objects fall back to GM.
//   - Per-member accumulators track: ddiCount, lease IPs (active, deduplicated),
//     raw lease row count (all binding_states).
//   - familyCounts tracks DDI-adjusted counts per family (HOST_OBJECT uses +2/+3, not +1).
//   - Global IP set deduplicates across all four sources: leases, fixed addresses,
//     host addresses, and network reservations (plus discovery_data as a Go extension).
package nios

import (
	"net"
	"sort"
	"strconv"
	"strings"
)

// NiosServerMetric holds per-member DDI usage and service metrics.
// Exported for use by the results API (server/types.go) and Phase 11 frontend panels.
// JSON field names match API contract section 6.
type NiosServerMetric struct {
	MemberID        string          `json:"memberId"`
	MemberName      string          `json:"memberName"`
	Role            string          `json:"role"`
	Model           string          `json:"model"`                      // Hardware model from physical_node hwtype (e.g., IB-V2215, IB-825)
	Platform        string          `json:"platform"`                   // Platform type derived from hwplatform (Physical, VMware, AWS, Azure, GCP)
	QPS             int             `json:"qps"`
	LPS             int             `json:"lps"`
	ObjectCount     int             `json:"objectCount"`
	ActiveIPCount   int             `json:"activeIPCount"`              // UDDI estimated Active IPs (leases + fixed_address)
	ManagedIPCount  int             `json:"managedIPCount"`             // NIOS managed Active IPs (UDDI + host_address)
	StaticHosts     int             `json:"staticHosts"`                // from member_dhcp_properties
	DynamicHosts    int             `json:"dynamicHosts"`               // from member_dhcp_properties
	DHCPUtilization int             `json:"dhcpUtilization"`            // scaled integer (268 = 26.8%)
	Licenses        map[string]bool `json:"licenses,omitempty"`         // per-member license types
}

// NiosGridFeatures holds grid-wide feature detection flags.
// Populated by checking for presence of specific XML object types during parsing.
type NiosGridFeatures struct {
	DNAMERecords  bool `json:"dnameRecords"`
	DNSAnycast    bool `json:"dnsAnycast"`
	CaptivePortal bool `json:"captivePortal"`
	DHCPv6        bool `json:"dhcpv6"`
	NTPServer     bool `json:"ntpServer"`
	DataConnector bool `json:"dataConnector"`
}

// NiosGridLicenses holds grid-wide license types (e.g. rpz, threat_anl, sec_eco, rpt_sub).
type NiosGridLicenses struct {
	Types []string `json:"types"`
}

// parsedObject is the in-memory representation of a single OBJECT element from onedb.xml
// after family classification. Created by the XML streaming layer in scanner.go.
type parsedObject struct {
	Family  string
	Props   map[string]string
	VnodeID string // non-empty only for LEASE family (vnode_id attribute)
}

// NiosMigrationFlags holds migration readiness flags parsed from the NIOS backup.
// DHCP options and /32 host routes require manual attention during migration to Universal DDI.
type NiosMigrationFlags struct {
	DHCPOptions []DHCPOptionFlag `json:"dhcpOptions"`
	HostRoutes  []HostRouteFlag  `json:"hostRoutes"`
}

// DHCPOptionFlag represents a DHCP option that requires migration attention.
type DHCPOptionFlag struct {
	Network      string `json:"network"`      // network address/CIDR the option is associated with
	OptionNumber int    `json:"optionNumber"`  // DHCP option number (code)
	OptionName   string `json:"optionName"`    // option name from XML definition
	OptionType   string `json:"optionType"`    // option value type (e.g. "ip-address", "text")
	Flag         string `json:"flag"`          // "VALIDATION_NEEDED" or "CHECK_GUARDRAILS"
	Member       string `json:"member"`        // owning member hostname
}

// HostRouteFlag represents a /32 network flagged as a host route.
type HostRouteFlag struct {
	Network string `json:"network"` // /32 network address
	Member  string `json:"member"`  // owning member hostname
}

// cidrEntry holds a parsed CIDR network and the member hostname that owns it.
// Used by resolveIPMember for longest-prefix matching.
type cidrEntry struct {
	network   *net.IPNet
	member    string
	prefixLen int
}

// memberResolver provides member attribution for DDI objects.
// Built in pass 1.5 from ns_group and dhcp_member relationships.
type memberResolver struct {
	// zoneMemberMap: zone reference (e.g. "._default.com.example") → primary member hostname
	zoneMemberMap map[string]string
	// networkMemberMap: network key (e.g. "10.1.51.0/24/0") → member hostname
	networkMemberMap map[string]string
	// cidrEntries: sorted by prefix length descending (longest match first)
	cidrEntries []cidrEntry
}

// resolveDNSMember returns the member hostname for a DNS record via its zone property.
func (mr *memberResolver) resolveDNSMember(zone string) string {
	if mr == nil || zone == "" {
		return ""
	}
	if h, ok := mr.zoneMemberMap[zone]; ok {
		return h
	}
	return ""
}

// resolveNetworkMember returns the member hostname for a network.
func (mr *memberResolver) resolveNetworkMember(network string) string {
	if mr == nil || network == "" {
		return ""
	}
	if h, ok := mr.networkMemberMap[network]; ok {
		return h
	}
	return ""
}

// resolveIPMember returns the member hostname that owns the subnet containing ip,
// using longest-prefix CIDR matching. Returns "" if no match.
func (mr *memberResolver) resolveIPMember(ip string) string {
	if mr == nil || ip == "" {
		return ""
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return ""
	}
	// cidrEntries is sorted by prefixLen descending, so first match is longest prefix.
	for _, entry := range mr.cidrEntries {
		if entry.network.Contains(parsed) {
			return entry.member
		}
	}
	return ""
}

// buildCIDREntries parses networkMemberMap keys into cidrEntry slice sorted by
// prefix length descending (longest match first).
func buildCIDREntries(networkMemberMap map[string]string) []cidrEntry {
	entries := make([]cidrEntry, 0, len(networkMemberMap))
	for key, hostname := range networkMemberMap {
		// Key format: "address/cidr/view" (e.g. "10.0.0.0/24/0")
		parts := strings.SplitN(key, "/", 3)
		if len(parts) < 2 {
			continue
		}
		cidrStr := parts[0] + "/" + parts[1]
		_, ipNet, err := net.ParseCIDR(cidrStr)
		if err != nil {
			continue
		}
		ones, _ := ipNet.Mask.Size()
		entries = append(entries, cidrEntry{
			network:   ipNet,
			member:    hostname,
			prefixLen: ones,
		})
	}
	// Sort by prefix length descending for longest-match-first.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].prefixLen > entries[j].prefixLen
	})
	return entries
}

// memberAcc is the per-member accumulator for counting objects during pass 2.
type memberAcc struct {
	ddiCount         int                 // DDI objects attributed to this member
	leaseIPSet       map[string]struct{} // deduplicated active lease IPs for this member
	memberIPSet      map[string]struct{} // deduplicated Active IPs across all sources for this member
	hostAddressIPSet map[string]struct{} // host_address IPs (for NIOS managed tier, separate from UDDI)
	leaseCount       int                 // raw lease row count (all binding_states, not filtered)
}

// countResult holds all per-member and grid-level counts produced by countObjects.
// Used internally by scanner.go to build FindingRows and NiosServerMetrics.
type countResult struct {
	memberAccs      map[string]*memberAcc    // keyed by member hostname
	memberDDI       map[string]map[string]int // hostname → family → DDI count (member-attributed)
	gridDDI         int                       // total DDI count across all members + unresolved
	familyCounts    map[string]int            // per-family DDI-adjusted counts (HOST_OBJECT uses +2/+3)
	globalIPSet     map[string]struct{}       // deduplicated IPs across all sources
	discoveryIPSet  map[string]struct{}       // discovery_data IPs only (for reporting)
	gridLeaseCount  int                       // total raw lease rows across all members
	unresolvedDDI   map[string]int            // family → count for objects not attributed to any member
	dhcpOptions     []DHCPOptionFlag          // DHCP options flagged for migration attention
	hostRoutes      []HostRouteFlag           // /32 networks flagged as host routes
}

// getOrCreateAcc returns the memberAcc for hostname, creating it if absent.
func (cr *countResult) getOrCreateAcc(hostname string) *memberAcc {
	if acc, ok := cr.memberAccs[hostname]; ok {
		return acc
	}
	acc := &memberAcc{
		leaseIPSet:       make(map[string]struct{}),
		memberIPSet:      make(map[string]struct{}),
		hostAddressIPSet: make(map[string]struct{}),
	}
	cr.memberAccs[hostname] = acc
	return acc
}

// addMemberDDI adds a DDI count delta for a family to a specific member.
func (cr *countResult) addMemberDDI(hostname, family string, delta int) {
	if cr.memberDDI[hostname] == nil {
		cr.memberDDI[hostname] = make(map[string]int)
	}
	cr.memberDDI[hostname][family] += delta
	acc := cr.getOrCreateAcc(hostname)
	acc.ddiCount += delta
}

// newCountResult creates an initialized countResult ready for processObject calls.
func newCountResult() countResult {
	return countResult{
		memberAccs:     make(map[string]*memberAcc),
		memberDDI:      make(map[string]map[string]int),
		familyCounts:   make(map[string]int),
		globalIPSet:    make(map[string]struct{}),
		discoveryIPSet: make(map[string]struct{}),
		unresolvedDDI:  make(map[string]int),
	}
}

// classifyDHCPOption determines the migration flag for a DHCP option based on Kea compatibility.
// Returns "" for options Kea handles natively (no flag needed), "CHECK_GUARDRAILS" for options
// that work but may behave differently, and "VALIDATION_NEEDED" for unsupported options.
func classifyDHCPOption(optionSpace string, optionCode int) string {
	// Non-standard option spaces always need validation
	if optionSpace != "DHCP" {
		return "VALIDATION_NEEDED"
	}

	// Standard DHCP options that Kea does NOT natively support (commented out in Kea source)
	switch optionCode {
	case 80, // Rapid Commit — not supported
		83,  // iSNS — not supported
		95,  // LDAP — not supported
		120, // SIP Servers — not natively defined, needs custom option-def
		123, // GeoConf — not supported
		139, // MoS Address — not supported
		140, // MoS FQDN — not supported
		142, // ANDSF — not supported
		144, // GeoLoc — not supported
		145, // Forcerenew Nonce — not supported
		150, // TFTP Server Address (Cisco) — not natively defined, very common
		158, // PCP Server — not supported
		161, // MUD URL — not supported
		209, // PXE Config File — not supported
		210, // PXE Path Prefix — not supported
		211, // PXE Reboot Time — not supported
		220, // Subnet Allocation — not supported
		221: // Virtual Subnet Selection — not supported
		return "VALIDATION_NEEDED"
	}

	// Standard DHCP options Kea supports but with behavioral differences
	switch optionCode {
	case 43, // Vendor-Encapsulated — deferred processing, sub-options need manual config
		60,  // Vendor Class ID — classification model completely different from ISC DHCP
		77,  // User Class — raw binary in Kea vs structured in ISC DHCP
		82,  // Relay Agent Info — no stash-agent-options, link selection differs
		124, // VIVCO — multi-vendor limited pre-Kea 2.3
		125: // VIVSO — multi-vendor limited, config syntax completely different
		return "CHECK_GUARDRAILS"
	}

	// All other standard DHCP options: Kea handles natively
	return ""
}

// processObject processes a single parsed object and updates the countResult in place.
// This enables stream counting without collecting all objects into a slice first.
func (result *countResult) processObject(family string, props map[string]string, vnodeID string, vnodeMap map[string]string, gmHostname string, resolver *memberResolver) {
	switch family {
	case NiosFamilyLease:
		state := props["binding_state"]
		ip := strings.TrimSpace(props["ip_address"])

		// Resolve member hostname via vnodeMap; fall back to GM.
		memberHost := gmHostname
		if vnodeID != "" {
			if h, ok := vnodeMap[vnodeID]; ok {
				memberHost = h
			}
		}

		// Always count raw lease rows (all binding_states).
		result.gridLeaseCount++
		if memberHost != "" {
			acc := result.getOrCreateAcc(memberHost)
			acc.leaseCount++
		}

		// Only active leases contribute to IP sets.
		if state == "active" && ip != "" {
			result.globalIPSet[ip] = struct{}{}
			if memberHost != "" {
				acc := result.getOrCreateAcc(memberHost)
				acc.leaseIPSet[ip] = struct{}{}
				acc.memberIPSet[ip] = struct{}{}
			}
		}

	case NiosFamilyFixedAddress:
		ip := strings.TrimSpace(props["ip_address"])
		if ip != "" {
			result.globalIPSet[ip] = struct{}{}
			memberHost := resolver.resolveIPMember(ip)
			if memberHost == "" {
				memberHost = gmHostname
			}
			if memberHost != "" {
				acc := result.getOrCreateAcc(memberHost)
				acc.memberIPSet[ip] = struct{}{}
			}
		}

	case NiosFamilyHostAddress:
		// Host addresses are DNS management objects (host record A entries).
		// Per the Infoblox UDDI reference methodology, host_address IPs are NOT
		// counted as UDDI Active IPs (which covers only DHCP leases + fixed addresses).
		// They ARE counted in the "Managed NIOS Active IPs" tier (UDDI + host_address).
		// Track in hostAddressIPSet separately from memberIPSet for the two-tier split.
		ip := strings.TrimSpace(props["address"])
		if ip != "" {
			result.globalIPSet[ip] = struct{}{}
			memberHost := resolver.resolveIPMember(ip)
			if memberHost == "" {
				memberHost = gmHostname
			}
			if memberHost != "" {
				acc := result.getOrCreateAcc(memberHost)
				acc.hostAddressIPSet[ip] = struct{}{}
			}
		}

	case NiosFamilyNetwork:
		delta := 1
		result.familyCounts[NiosFamilyNetwork] += delta
		result.gridDDI += delta

		networkKey := strings.TrimSpace(props["address"])
		cidrVal := strings.TrimSpace(props["cidr"])
		nwView := props["network_view"]

		var fullCIDR string
		if strings.Contains(cidrVal, "/") {
			fullCIDR = cidrVal
		} else if networkKey != "" && cidrVal != "" {
			fullCIDR = networkKey + "/" + cidrVal
		}

		if networkKey != "" && cidrVal != "" && nwView != "" {
			lookupKey := networkKey + "/" + cidrVal + "/" + nwView
			if memberHost := resolver.resolveNetworkMember(lookupKey); memberHost != "" {
				result.addMemberDDI(memberHost, NiosFamilyNetwork, delta)
			} else {
				result.unresolvedDDI[NiosFamilyNetwork] += delta
			}
		} else {
			result.unresolvedDDI[NiosFamilyNetwork] += delta
		}

		if fullCIDR != "" {
			if _, ipNet, err := net.ParseCIDR(fullCIDR); err == nil {
				// Network address and broadcast are infrastructure, not active IPs.
				// Only DHCP leases and fixed addresses count toward Active IPs per
				// the Infoblox UDDI reference methodology. Network objects contribute
				// to DDI object count only.
				_ = ipNet

				// Flag /32 networks as host routes for migration attention.
				// The network still counts as a DDI object (additive flag, not replacement).
				ones, _ := ipNet.Mask.Size()
				if ones == 32 {
					memberHost := ""
					if networkKey != "" && cidrVal != "" && nwView != "" {
						lookupKey := networkKey + "/" + cidrVal + "/" + nwView
						memberHost = resolver.resolveNetworkMember(lookupKey)
					}
					result.hostRoutes = append(result.hostRoutes, HostRouteFlag{
						Network: fullCIDR,
						Member:  memberHost,
					})
				}
			}
		}

	case NiosFamilyDHCPOption:
		// DHCP options are metadata, not DDI objects. Collect for migration flags.
		// Option definition format: "SPACE..false.CODE" (e.g. "DHCP..false.42" or "Cisco_AP..false.241")
		optionDef := props["option_definition"]
		parentRef := props["parent"]

		// Extract network reference from parent (format: ".com.infoblox.dns.network$ADDRESS/CIDR/VIEW")
		network := ""
		if idx := strings.Index(parentRef, "$"); idx >= 0 {
			network = parentRef[idx+1:]
		}

		// Parse option code from option_definition (last segment after last ".")
		optionCode := 0
		optionSpace := "DHCP"
		if optionDef != "" {
			parts := strings.Split(optionDef, ".")
			if len(parts) > 0 {
				code, err := strconv.Atoi(parts[len(parts)-1])
				if err == nil {
					optionCode = code
				}
			}
			// Extract option space (first segment before "..")
			if dotDot := strings.Index(optionDef, ".."); dotDot > 0 {
				optionSpace = optionDef[:dotDot]
			}
		}

		// Classification based on Kea DHCP compatibility:
		// - Non-standard option spaces (not "DHCP") => always VALIDATION_NEEDED
		// - Standard DHCP options NOT natively supported by Kea => VALIDATION_NEEDED
		// - Standard DHCP options supported but with behavioral differences => CHECK_GUARDRAILS
		// - Standard DHCP options fully supported by Kea => no flag (skip)
		flag := classifyDHCPOption(optionSpace, optionCode)

		// Skip options that Kea handles natively (no migration concern)
		if flag == "" {
			break
		}

		// Resolve owning member via network reference
		memberHost := ""
		if network != "" {
			memberHost = resolver.resolveNetworkMember(network)
		}

		result.dhcpOptions = append(result.dhcpOptions, DHCPOptionFlag{
			Network:      network,
			OptionNumber: optionCode,
			OptionName:   "", // populated from option_definition lookup if available
			OptionType:   optionSpace,
			Flag:         flag,
			Member:       memberHost,
		})

	case NiosFamilyHostObject:
		aliases := strings.TrimSpace(props["aliases"])
		delta := 2
		if aliases != "" {
			delta = 3
		}
		result.familyCounts[NiosFamilyHostObject] += delta
		result.gridDDI += delta

		zone := props["zone"]
		if memberHost := resolver.resolveDNSMember(zone); memberHost != "" {
			result.addMemberDDI(memberHost, NiosFamilyHostObject, delta)
		} else {
			result.unresolvedDDI[NiosFamilyHostObject] += delta
		}

	case NiosFamilyDiscoveryData:
		// Discovery data (NetMRI/active discovery) is not counted as Active IPs
		// in the Infoblox UDDI reference methodology. Only DHCP leases and fixed
		// addresses are counted. Discovery data is retained in discoveryIPSet for
		// informational use but excluded from globalIPSet and memberIPSet.
		ip := strings.TrimSpace(props["ip_address"])
		if ip != "" {
			result.discoveryIPSet[ip] = struct{}{}
		}

	default:
		if _, isDDI := DDIFamilies[family]; isDDI {
			delta := 1
			result.familyCounts[family] += delta
			result.gridDDI += delta

			zone := props["zone"]
			memberProp := props["member"]

			memberHost := ""
			if zone != "" {
				memberHost = resolver.resolveDNSMember(zone)
			}
			if memberHost == "" && memberProp != "" {
				if h, ok := vnodeMap[memberProp]; ok {
					memberHost = h
				}
			}

			if memberHost != "" {
				result.addMemberDDI(memberHost, family, delta)
			} else {
				result.unresolvedDDI[family] += delta
			}
		}
	}
}

// countObjects processes a slice of parsed objects and produces per-member DDI/IP counts.
// Kept for backward compatibility with tests; delegates to processObject per item.
func countObjects(objects []parsedObject, vnodeMap map[string]string, gmHostname string, resolver *memberResolver) countResult {
	result := newCountResult()
	for _, obj := range objects {
		result.processObject(obj.Family, obj.Props, obj.VnodeID, vnodeMap, gmHostname, resolver)
	}
	return result
}

// ceilDiv computes ceiling(n / d). Returns 0 if n is 0.
func ceilDiv(n, d int) int {
	if n == 0 {
		return 0
	}
	return (n + d - 1) / d
}
