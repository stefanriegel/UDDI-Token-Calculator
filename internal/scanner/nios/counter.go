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
	"strings"
)

// NiosServerMetric holds per-member DDI usage and service metrics.
// Exported for use by the results API (server/types.go) and Phase 11 frontend panels.
// JSON field names match API contract section 6.
type NiosServerMetric struct {
	MemberID    string `json:"memberId"`
	MemberName  string `json:"memberName"`
	Role        string `json:"role"`
	QPS         int    `json:"qps"`
	LPS         int    `json:"lps"`
	ObjectCount int    `json:"objectCount"`
}

// parsedObject is the in-memory representation of a single OBJECT element from onedb.xml
// after family classification. Created by the XML streaming layer in scanner.go.
type parsedObject struct {
	Family  string
	Props   map[string]string
	VnodeID string // non-empty only for LEASE family (vnode_id attribute)
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
	ddiCount    int                 // DDI objects attributed to this member
	leaseIPSet  map[string]struct{} // deduplicated active lease IPs for this member
	memberIPSet map[string]struct{} // deduplicated Active IPs across all sources for this member
	leaseCount  int                 // raw lease row count (all binding_states, not filtered)
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
}

// getOrCreateAcc returns the memberAcc for hostname, creating it if absent.
func (cr *countResult) getOrCreateAcc(hostname string) *memberAcc {
	if acc, ok := cr.memberAccs[hostname]; ok {
		return acc
	}
	acc := &memberAcc{
		leaseIPSet:  make(map[string]struct{}),
		memberIPSet: make(map[string]struct{}),
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
		ip := strings.TrimSpace(props["address"])
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
			if netIP, ipNet, err := net.ParseCIDR(fullCIDR); err == nil {
				networkAddr := netIP.Mask(ipNet.Mask).String()
				result.globalIPSet[networkAddr] = struct{}{}
				mask := ipNet.Mask
				broadcast := make(net.IP, len(ipNet.IP))
				for i := range ipNet.IP {
					broadcast[i] = ipNet.IP[i] | ^mask[i]
				}
				bcastStr := broadcast.String()
				result.globalIPSet[bcastStr] = struct{}{}

				nwMemberHost := ""
				if networkKey != "" && cidrVal != "" && nwView != "" {
					lookupKey := networkKey + "/" + cidrVal + "/" + nwView
					nwMemberHost = resolver.resolveNetworkMember(lookupKey)
				}
				if nwMemberHost == "" {
					nwMemberHost = gmHostname
				}
				if nwMemberHost != "" {
					acc := result.getOrCreateAcc(nwMemberHost)
					acc.memberIPSet[networkAddr] = struct{}{}
					acc.memberIPSet[bcastStr] = struct{}{}
				}
			}
		}

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
		ip := strings.TrimSpace(props["ip_address"])
		if ip != "" {
			result.globalIPSet[ip] = struct{}{}
			result.discoveryIPSet[ip] = struct{}{}
			memberHost := resolver.resolveIPMember(ip)
			if memberHost == "" {
				memberHost = gmHostname
			}
			if memberHost != "" {
				acc := result.getOrCreateAcc(memberHost)
				acc.memberIPSet[ip] = struct{}{}
			}
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
