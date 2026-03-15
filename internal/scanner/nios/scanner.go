// Package nios implements the NIOS backup scanner for Phase 10.
// scanner.go implements a three-pass streaming XML parser:
//   Pass 1: build vnodeMap (vnode_id → hostname) and find Grid Master
//   Pass 1.5: build memberResolver (zone → member, network → member) from ns_group + dhcp_member
//   Pass 2: count DDI objects with per-member attribution via resolver
package nios

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Scanner is the NIOS provider implementation.
// It implements both scanner.Scanner and scanner.NiosResultScanner.
type Scanner struct {
	mu      sync.Mutex
	metrics []NiosServerMetric
}

// New returns a new NIOS Scanner.
func New() *Scanner { return &Scanner{} }

// GetNiosServerMetricsJSON returns JSON-encoded []NiosServerMetric after Scan() completes.
// Returns nil if Scan() has not been called or produced no metrics.
func (s *Scanner) GetNiosServerMetricsJSON() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.metrics) == 0 {
		return nil
	}
	data, err := json.Marshal(s.metrics)
	if err != nil {
		return nil
	}
	return data
}

// Scan implements scanner.Scanner. It performs a three-pass streaming parse of the
// NIOS backup archive referenced by req.Credentials["backup_path"].
//
// Pass 1: builds vnode_id → hostname map and identifies the Grid Master.
// Pass 1.5: builds zone → member and network → member resolver maps.
// Pass 2: counts DDI objects with per-member attribution via resolver.
//
// The temp file at backup_path is deleted via defer after the scan completes.
func (s *Scanner) Scan(_ context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	backupPath := req.Credentials["backup_path"]
	if backupPath == "" {
		return nil, fmt.Errorf("nios: backup_path not set in credentials")
	}

	// Delete temp file when done — only if the path is inside os.TempDir()
	// so test fixtures in testdata/ are not accidentally deleted.
	if strings.HasPrefix(filepath.Clean(backupPath), filepath.Clean(os.TempDir())) {
		defer os.Remove(backupPath)
	}

	// Parse selected members filter.
	selectedSet := make(map[string]struct{})
	if sm := req.Credentials["selected_members"]; sm != "" {
		for _, h := range strings.Split(sm, ",") {
			h = strings.TrimSpace(h)
			if h != "" {
				selectedSet[h] = struct{}{}
			}
		}
	}

	// ---- Pass 1: build vnodeMap (virtual_oid → hostname) and find GM ----
	vnodeMap := make(map[string]string)            // vnode_id → hostname
	memberProps := make(map[string]map[string]string) // hostname → props
	gmHostname := ""

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "pass1_start",
		Count:    0,
	})

	if err := streamOnedbXML(backupPath, func(props map[string]string) {
		xmlType := props["__type"]
		if _, isMember := MemberXMLTypes[xmlType]; !isMember {
			return
		}
		oid := props["virtual_oid"]
		hostname := props["host_name"]
		if oid == "" || hostname == "" {
			return
		}
		vnodeMap[oid] = hostname
		// Clone props for role extraction later.
		cloned := make(map[string]string, len(props))
		for k, v := range props {
			cloned[k] = v
		}
		memberProps[hostname] = cloned
		if props["is_master"] == "true" || props["is_grid_master"] == "true" {
			gmHostname = hostname
		}
	}); err != nil {
		return nil, fmt.Errorf("nios: pass 1 failed: %w", err)
	}

	// gmHostname fallback: if is_master was not found in any member,
	// use the first member hostname from vnodeMap.
	if gmHostname == "" && len(vnodeMap) > 0 {
		for _, h := range vnodeMap {
			gmHostname = h
			break
		}
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "members",
		Count:    len(vnodeMap),
	})

	// ---- Pass 1.5: build member resolver (zone → member, network → member) ----
	resolver := buildMemberResolver(backupPath, vnodeMap)

	// ---- Pass 2: collect all parsedObjects and count ----
	var objects []parsedObject

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "pass2_start",
		Count:    0,
	})

	if err := streamOnedbXML(backupPath, func(props map[string]string) {
		xmlType := props["__type"]
		family, ok := XMLTypeToFamily[xmlType]
		if !ok {
			return
		}
		obj := parsedObject{
			Family:  family,
			Props:   props,
			VnodeID: props["vnode_id"],
		}
		objects = append(objects, obj)
	}); err != nil {
		return nil, fmt.Errorf("nios: pass 2 failed: %w", err)
	}

	result := countObjects(objects, vnodeMap, gmHostname, resolver)

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "objects",
		Count:    len(objects),
	})

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "counting",
		Count:    result.gridDDI,
	})

	// ---- Build FindingRows ----
	var rows []calculator.FindingRow

	// Emit per-member DDI rows: each member gets rows for the DDI families attributed to it.
	for hostname, familyMap := range result.memberDDI {
		for family, count := range familyMap {
			if count == 0 {
				continue
			}
			displayName := familyDisplayName(family)
			rows = append(rows, calculator.FindingRow{
				Provider:         "nios",
				Source:           hostname,
				Category:         calculator.CategoryDDIObjects,
				Item:             displayName,
				Count:            count,
				TokensPerUnit:    calculator.TokensPerDDIObject,
				ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
			})
		}
	}

	// Emit rows for unresolved DDI objects (attributed to GM as fallback).
	for family, count := range result.unresolvedDDI {
		if count == 0 {
			continue
		}
		displayName := familyDisplayName(family)
		rows = append(rows, calculator.FindingRow{
			Provider:         "nios",
			Source:           gmHostname,
			Category:         calculator.CategoryDDIObjects,
			Item:             displayName,
			Count:            count,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
		})
	}

	// Per-member Active IPs — each member gets a row for IPs in subnets it owns.
	// Leases are attributed via vnode_id; fixed/host/discovery via CIDR containment;
	// network IPs via network→member mapping. Deduplication is per-member (memberIPSet).
	for hostname, acc := range result.memberAccs {
		if len(acc.memberIPSet) > 0 {
			rows = append(rows, calculator.FindingRow{
				Provider:         "nios",
				Source:           hostname,
				Category:         calculator.CategoryActiveIPs,
				Item:             "Active IPs",
				Count:            len(acc.memberIPSet),
				TokensPerUnit:    calculator.TokensPerActiveIP,
				ManagementTokens: ceilDiv(len(acc.memberIPSet), calculator.TokensPerActiveIP),
			})
		}
	}

	// ---- Apply selectedMembers filter ----
	// If selectedMembers is non-empty, only emit rows for hostnames in the set.
	// GM is always included even if not in selectedMembers.
	if len(selectedSet) > 0 {
		filtered := rows[:0]
		for _, row := range rows {
			if row.Source == gmHostname {
				filtered = append(filtered, row)
				continue
			}
			if _, ok := selectedSet[row.Source]; ok {
				filtered = append(filtered, row)
			}
		}
		rows = filtered
	}

	// ---- Build NiosServerMetrics ----
	s.mu.Lock()
	s.metrics = buildMetrics(vnodeMap, memberProps, result, gmHostname)
	s.mu.Unlock()

	return rows, nil
}

// buildMemberResolver creates the memberResolver by scanning the backup for
// ns_group, ns_group_grid_primary, and dhcp_member objects.
//
// Zone → member resolution chain:
//   zone.assigned_ns_group → ns_group.group_name → ns_group_grid_primary.grid_member (oid) → vnodeMap → hostname
//
// Network → member resolution:
//   dhcp_member.network → dhcp_member.member (oid) → vnodeMap → hostname
func buildMemberResolver(backupPath string, vnodeMap map[string]string) *memberResolver {
	// Collect ns_group_grid_primary: ns_group name → member oid (use first/primary)
	nsGroupPrimary := make(map[string]string) // ns_group name → member oid
	// Collect dhcp_member: network key → member oid (use first)
	dhcpMembers := make(map[string]string) // network key → member oid
	// Collect zone: zone ref → assigned_ns_group
	zoneNSGroup := make(map[string]string) // zone unique key → ns_group name

	_ = streamOnedbXML(backupPath, func(props map[string]string) {
		xmlType := props["__type"]
		switch xmlType {
		case ".com.infoblox.dns.ns_group_grid_primary":
			// grid_member is an oid string referencing vnodeMap.
			nsGroup := props["ns_group"]
			memberOID := props["grid_member"]
			if nsGroup != "" && memberOID != "" {
				// Keep first (primary) member per ns_group.
				if _, exists := nsGroupPrimary[nsGroup]; !exists {
					nsGroupPrimary[nsGroup] = memberOID
				}
			}
		case ".com.infoblox.dns.dhcp_member":
			network := props["network"]
			memberOID := props["member"]
			if network != "" && memberOID != "" {
				// Keep first member per network.
				if _, exists := dhcpMembers[network]; !exists {
					dhcpMembers[network] = memberOID
				}
			}
		case ".com.infoblox.dns.zone":
			// Zone objects have a unique "zone" property (e.g. "._default.com.example")
			// and "assigned_ns_group" naming the ns_group.
			zoneRef := props["zone"]
			nsGroup := props["assigned_ns_group"]
			if zoneRef != "" && nsGroup != "" {
				zoneNSGroup[zoneRef] = nsGroup
			}
		}
	})

	// Build zoneMemberMap: zone ref → hostname
	zoneMemberMap := make(map[string]string, len(zoneNSGroup))
	for zoneRef, nsGroup := range zoneNSGroup {
		if memberOID, ok := nsGroupPrimary[nsGroup]; ok {
			if hostname, ok := vnodeMap[memberOID]; ok {
				zoneMemberMap[zoneRef] = hostname
			}
		}
	}

	// Build networkMemberMap: network key → hostname
	networkMemberMap := make(map[string]string, len(dhcpMembers))
	for network, memberOID := range dhcpMembers {
		if hostname, ok := vnodeMap[memberOID]; ok {
			networkMemberMap[network] = hostname
		}
	}

	return &memberResolver{
		zoneMemberMap:    zoneMemberMap,
		networkMemberMap: networkMemberMap,
		cidrEntries:      buildCIDREntries(networkMemberMap),
	}
}

// buildMetrics constructs NiosServerMetric entries for each member in vnodeMap.
// ObjectCount uses member-attributed DDI from countResult.memberDDI.
// Unresolved DDI is added to the Grid Master's count.
func buildMetrics(
	vnodeMap map[string]string,
	memberProps map[string]map[string]string,
	result countResult,
	gmHostname string,
) []NiosServerMetric {
	// Sum unresolved DDI for GM attribution.
	unresolvedTotal := 0
	for _, count := range result.unresolvedDDI {
		unresolvedTotal += count
	}

	metrics := make([]NiosServerMetric, 0, len(vnodeMap))
	for _, hostname := range vnodeMap {
		props := memberProps[hostname]
		role := extractServiceRole(props)

		objectCount := 0
		if acc, ok := result.memberAccs[hostname]; ok {
			objectCount = acc.ddiCount
		}
		// GM gets unresolved DDI (objects not attributed to any specific member).
		if hostname == gmHostname {
			objectCount += unresolvedTotal
		}

		metrics = append(metrics, NiosServerMetric{
			MemberID:    hostname,
			MemberName:  hostname,
			Role:        role,
			QPS:         0,
			LPS:         0,
			ObjectCount: objectCount,
		})
	}
	return metrics
}

// familyDisplayNames maps NiosFamily constants to human-readable display names
// for the FindingRow Item field.
var familyDisplayNames = map[string]string{
	NiosFamilyDNSZone:          "DNS Zones",
	NiosFamilyDNSRecordA:      "DNS A Records",
	NiosFamilyDNSRecordAAAA:   "DNS AAAA Records",
	NiosFamilyDNSRecordCNAME:  "DNS CNAME Records",
	NiosFamilyDNSRecordMX:     "DNS MX Records",
	NiosFamilyDNSRecordNS:     "DNS NS Records",
	NiosFamilyDNSRecordPTR:    "DNS PTR Records",
	NiosFamilyDNSRecordSOA:    "DNS SOA Records",
	NiosFamilyDNSRecordSRV:    "DNS SRV Records",
	NiosFamilyDNSRecordTXT:    "DNS TXT Records",
	NiosFamilyNetwork:         "DHCP Networks",
	NiosFamilyHostObject:      "Host Records",
	NiosFamilyHostAlias:       "Host Aliases",
	NiosFamilyFixedAddress:    "Fixed Addresses",
	NiosFamilyDHCPRange:       "DHCP Ranges",
	NiosFamilyExclusionRange:  "Exclusion Ranges",
	NiosFamilyNetworkContainer: "Network Containers",
	NiosFamilyNetworkView:     "Network Views",
	NiosFamilyDTCLBDN:         "DTC Load-Balanced Names",
	NiosFamilyDTCPool:         "DTC Pools",
	NiosFamilyDTCServer:       "DTC Servers",
	NiosFamilyDTCMonitor:      "DTC Monitors",
	NiosFamilyDTCTopology:     "DTC Topologies",
	NiosFamilyDiscoveryData:   "Discovered IPs",
}

// familyDisplayName returns the human-readable name for a NiosFamily constant.
// Falls back to "Other DDI Objects" for unmapped families.
func familyDisplayName(family string) string {
	if name, ok := familyDisplayNames[family]; ok {
		return name
	}
	return "Other DDI Objects"
}

// streamOnedbXML opens the gzip+tar backup at path, finds onedb.xml, and calls
// onObject for each OBJECT element's collected PROPERTY map.
// It handles the file open/close lifecycle internally for multi-pass streaming.
func streamOnedbXML(path string, onObject func(props map[string]string)) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip reader: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		if filepath.Base(hdr.Name) != "onedb.xml" {
			continue
		}
		return parseObjectStream(tr, onObject)
	}
	return fmt.Errorf("onedb.xml not found in archive")
}

// parseObjectStream streams XML tokens from r, calling onObject for each complete
// OBJECT element. Uses token-based parsing to avoid loading the full document.
// PROPERTY elements have NAME and VALUE as XML attributes (not child elements).
func parseObjectStream(r io.Reader, onObject func(props map[string]string)) error {
	decoder := xml.NewDecoder(r)
	var currentProps map[string]string
	inObject := false

	for {
		tok, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("XML parse error: %w", err)
		}

		switch t := tok.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "OBJECT":
				inObject = true
				currentProps = make(map[string]string)
			case "PROPERTY":
				if !inObject {
					continue
				}
				var name, value string
				for _, attr := range t.Attr {
					switch attr.Name.Local {
					case "NAME":
						name = attr.Value
					case "VALUE":
						value = attr.Value
					}
				}
				if name != "" {
					currentProps[name] = value
				}
			}

		case xml.EndElement:
			if t.Name.Local == "OBJECT" && inObject {
				inObject = false
				if currentProps != nil {
					onObject(currentProps)
				}
				currentProps = nil
			}
		}
	}
	return nil
}
