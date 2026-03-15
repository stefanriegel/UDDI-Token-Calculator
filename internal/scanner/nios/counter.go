// Package nios provides the NIOS backup scanner for Phase 10.
// counter.go defines the per-member accumulator and object counting logic.
// No file I/O or XML streaming here — this is pure business logic tested in isolation.
//
// Counting model (matching Python counter.py reference exactly):
//   - DDI objects are GRID-LEVEL (member_hostname=None in Python). They go into gridDDI,
//     NOT into any member accumulator. Only LEASE objects have member attribution (via vnode_id).
//   - Per-member accumulators track: lease IPs (active, deduplicated), raw lease row count
//     (all binding_states), and DDI count (always 0 in current NIOS version since only
//     LEASE is member-scoped and LEASE is not a DDI family).
//   - familyCounts tracks DDI-adjusted counts per family (HOST_OBJECT uses +2/+3, not +1).
//   - Global IP set deduplicates across all four sources: leases, fixed addresses,
//     host addresses, and network reservations (plus discovery_data as a Go extension).
package nios

import (
	"net"
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

// memberAcc is the per-member accumulator for counting objects during pass 2.
// Matches Python _MemberAcc: ddi_count, lease_ip_set, lease_count.
type memberAcc struct {
	ddiCount   int                  // DDI objects attributed to this member (currently always 0; only LEASE is member-scoped and LEASE is not DDI)
	leaseIPSet map[string]struct{}  // deduplicated active lease IPs for this member
	leaseCount int                  // raw lease row count (all binding_states, not filtered)
}

// countResult holds all per-member and grid-level counts produced by countObjects.
// Used internally by scanner.go to build FindingRows and NiosServerMetrics.
type countResult struct {
	memberAccs     map[string]*memberAcc // keyed by member hostname (from LEASE vnode_id resolution)
	gridDDI        int                   // grid-level DDI count (all DDI families are grid-level)
	familyCounts   map[string]int        // per-family DDI-adjusted counts (HOST_OBJECT uses +2/+3)
	globalIPSet    map[string]struct{}   // deduplicated IPs across all sources
	discoveryIPSet map[string]struct{}   // discovery_data IPs only (for reporting)
	gridLeaseCount int                   // total raw lease rows across all members
}

// getOrCreateAcc returns the memberAcc for hostname, creating it if absent.
func (cr *countResult) getOrCreateAcc(hostname string) *memberAcc {
	if acc, ok := cr.memberAccs[hostname]; ok {
		return acc
	}
	acc := &memberAcc{
		leaseIPSet: make(map[string]struct{}),
	}
	cr.memberAccs[hostname] = acc
	return acc
}

// countObjects processes a slice of parsed objects and produces per-member DDI/IP counts.
//
// Parameters:
//   - objects: slice of parsedObject from XML streaming (pass 2)
//   - vnodeMap: map from vnode_id string to member hostname (built in pass 1)
//   - gmHostname: hostname of the Grid Master (used as fallback for unresolvable vnode_ids)
//
// Counting rules (from Python counter.py reference):
//   - All DDI families: counted in gridDDI (grid-level, no member attribution)
//   - HOST_OBJECT: +2 DDI (A+PTR) or +3 DDI (A+PTR+CNAME if aliases non-empty after trim)
//   - NETWORK: +1 DDI to gridDDI, adds network+broadcast IPs to globalIPSet
//   - FIXED_ADDRESS: adds Props["ip_address"] to globalIPSet (grid-level, not DDI)
//   - HOST_ADDRESS: adds Props["address"] to globalIPSet (NOT "ip_address", not DDI)
//   - LEASE: ALL rows counted in gridLeaseCount and per-member leaseCount (regardless of
//     binding_state). Only active leases contribute IPs to per-member leaseIPSet and globalIPSet.
//     Member attribution via vnodeMap[VnodeID]; unresolvable falls back to gmHostname.
//   - DISCOVERY_DATA: adds Props["ip_address"] to globalIPSet (Go extension, not in Python)
func countObjects(objects []parsedObject, vnodeMap map[string]string, gmHostname string) countResult {
	result := countResult{
		memberAccs:     make(map[string]*memberAcc),
		familyCounts:   make(map[string]int),
		globalIPSet:    make(map[string]struct{}),
		discoveryIPSet: make(map[string]struct{}),
	}

	for _, obj := range objects {
		switch obj.Family {
		case NiosFamilyLease:
			state := obj.Props["binding_state"]
			ip := strings.TrimSpace(obj.Props["ip_address"])

			// Resolve member hostname via vnodeMap; fall back to GM.
			memberHost := gmHostname
			if obj.VnodeID != "" {
				if h, ok := vnodeMap[obj.VnodeID]; ok {
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
				// Global deduplication.
				result.globalIPSet[ip] = struct{}{}
				// Per-member deduplication.
				if memberHost != "" {
					acc := result.getOrCreateAcc(memberHost)
					acc.leaseIPSet[ip] = struct{}{}
				}
			}

		case NiosFamilyFixedAddress:
			ip := strings.TrimSpace(obj.Props["ip_address"])
			if ip != "" {
				result.globalIPSet[ip] = struct{}{}
			}

		case NiosFamilyHostAddress:
			// HOST_ADDRESS uses "address" key, not "ip_address" (confirmed in ZF backup).
			ip := strings.TrimSpace(obj.Props["address"])
			if ip != "" {
				result.globalIPSet[ip] = struct{}{}
			}

		case NiosFamilyNetwork:
			// +1 DDI to grid-level, and add network+broadcast addresses to global IP set.
			delta := 1
			result.familyCounts[NiosFamilyNetwork] += delta
			result.gridDDI += delta

			cidr := strings.TrimSpace(obj.Props["cidr"])
			if cidr != "" {
				if netIP, ipNet, err := net.ParseCIDR(cidr); err == nil {
					// Network address (first IP).
					networkAddr := netIP.Mask(ipNet.Mask).String()
					result.globalIPSet[networkAddr] = struct{}{}

					// Broadcast address: network_address | ^mask.
					mask := ipNet.Mask
					broadcast := make(net.IP, len(ipNet.IP))
					for i := range ipNet.IP {
						broadcast[i] = ipNet.IP[i] | ^mask[i]
					}
					result.globalIPSet[broadcast.String()] = struct{}{}
				}
			}

		case NiosFamilyHostObject:
			// HOST_OBJECT expands to +2 (A+PTR) or +3 (A+PTR+CNAME) if aliases non-empty.
			// Python: aliases = attrs.get("aliases", "").strip()
			aliases := strings.TrimSpace(obj.Props["aliases"])
			delta := 2
			if aliases != "" {
				delta = 3
			}
			// familyCounts tracks DDI-adjusted count (matching Python per_family_ddi).
			result.familyCounts[NiosFamilyHostObject] += delta
			result.gridDDI += delta

		case NiosFamilyDiscoveryData:
			// Discovery data contributes ip_address to Active IP dedup set.
			// Not a DDI family, not member-scoped. (Go extension, not in Python reference.)
			ip := strings.TrimSpace(obj.Props["ip_address"])
			if ip != "" {
				result.globalIPSet[ip] = struct{}{}
				result.discoveryIPSet[ip] = struct{}{}
			}

		default:
			// All remaining DDI families: +1 to grid-level DDI.
			if _, isDDI := DDIFamilies[obj.Family]; isDDI {
				result.familyCounts[obj.Family]++
				result.gridDDI++
			}
			// Non-DDI, non-IP families (e.g. member objects) are ignored here.
		}
	}

	return result
}
