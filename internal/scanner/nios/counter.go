// Package nios provides the NIOS backup scanner for Phase 10.
// counter.go defines the per-member accumulator and object counting logic.
// No file I/O or XML streaming here — this is pure business logic tested in isolation.
package nios

import "net"

// NiosServerMetric holds per-member DDI usage and service metrics.
// Exported for use by the results API (server/types.go) and Phase 11 frontend panels.
// JSON field names match API contract §6.
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
type memberAcc struct {
	ddiCount   int
	leaseIPSet map[string]struct{} // deduplicated active lease IPs for this member
	leaseCount int                 // count of unique active lease IPs
}

// countResult holds all per-member and grid-level counts produced by countObjects.
// Used internally by scanner.go to build FindingRows and NiosServerMetrics.
type countResult struct {
	memberAccs     map[string]*memberAcc // keyed by member hostname
	gridDDI        int                   // DDI count attributed to the grid master
	familyCounts   map[string]int        // per-family DDI counts (e.g. dns_zone -> 5)
	globalIPSet      map[string]struct{} // deduplicated IPs across all sources
	discoveryIPSet   map[string]struct{} // discovery_data IPs only (for reporting)
	gridLeaseCount   int                 // lease IPs attributed to unknown/grid members
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
//   - gmHostname: hostname of the Grid Master; grid-level DDI is attributed here
//
// Counting rules (from Python counter.py reference):
//   - DDI families (except HOST_OBJECT): +1 DDI attributed to gmHostname
//   - HOST_OBJECT: +2 DDI if no aliases, +3 DDI if aliases non-empty
//   - NETWORK: +1 DDI, adds network+broadcast IPs to globalIPSet
//   - FIXED_ADDRESS: adds Props["ip_address"] to globalIPSet (grid-level)
//   - HOST_ADDRESS: adds Props["address"] to globalIPSet (NOT "ip_address")
//   - LEASE with binding_state="active": adds Props["ip_address"] to both
//     per-member leaseIPSet and globalIPSet; attributed via vnodeMap[VnodeID]
func countObjects(objects []parsedObject, vnodeMap map[string]string, gmHostname string) countResult {
	result := countResult{
		memberAccs:     make(map[string]*memberAcc),
		familyCounts:   make(map[string]int),
		globalIPSet:    make(map[string]struct{}),
		discoveryIPSet: make(map[string]struct{}),
	}

	// Ensure the GM has an accumulator even if it has no direct DDI objects.
	if gmHostname != "" {
		result.getOrCreateAcc(gmHostname)
	}

	for _, obj := range objects {
		switch obj.Family {
		case NiosFamilyLease:
			// Only count active leases for IP deduplication.
			if obj.Props["binding_state"] != "active" {
				continue
			}
			ip := obj.Props["ip_address"]
			if ip == "" {
				continue
			}

			// Resolve member hostname via vnodeMap; fall back to GM.
			memberHost := gmHostname
			if obj.VnodeID != "" {
				if h, ok := vnodeMap[obj.VnodeID]; ok {
					memberHost = h
				}
			}

			acc := result.getOrCreateAcc(memberHost)
			// Per-member deduplication.
			if _, seen := acc.leaseIPSet[ip]; !seen {
				acc.leaseIPSet[ip] = struct{}{}
				acc.leaseCount++
			}
			// Global deduplication.
			result.globalIPSet[ip] = struct{}{}

		case NiosFamilyFixedAddress:
			ip := obj.Props["ip_address"]
			if ip != "" {
				result.globalIPSet[ip] = struct{}{}
			}

		case NiosFamilyHostAddress:
			// HOST_ADDRESS uses "address" key, not "ip_address".
			ip := obj.Props["address"]
			if ip != "" {
				result.globalIPSet[ip] = struct{}{}
			}

		case NiosFamilyNetwork:
			// +1 DDI, and add network+broadcast addresses to global IP set.
			result.familyCounts[NiosFamilyNetwork]++
			acc := result.getOrCreateAcc(gmHostname)
			acc.ddiCount++

			cidr := obj.Props["cidr"]
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
			result.familyCounts[NiosFamilyHostObject]++
			acc := result.getOrCreateAcc(gmHostname)
			if obj.Props["aliases"] != "" {
				acc.ddiCount += 3
			} else {
				acc.ddiCount += 2
			}

		case NiosFamilyDiscoveryData:
			// Discovery data contributes ip_address to Active IP dedup set.
			// Not a DDI family, not member-scoped.
			ip := obj.Props["ip_address"]
			if ip != "" {
				result.globalIPSet[ip] = struct{}{}
				result.discoveryIPSet[ip] = struct{}{}
			}

		default:
			// All remaining DDI families: +1 attributed to grid master.
			if _, isDDI := DDIFamilies[obj.Family]; isDDI {
				result.familyCounts[obj.Family]++
				acc := result.getOrCreateAcc(gmHostname)
				acc.ddiCount++
			}
			// Non-DDI, non-IP families (e.g. member objects) are ignored here.
		}
	}

	// Aggregate grid-level DDI from the GM accumulator.
	if gm, ok := result.memberAccs[gmHostname]; ok {
		result.gridDDI = gm.ddiCount
	}

	return result
}
