// Package nios implements the NIOS backup scanner for Phase 10.
// scanner.go implements a two-pass streaming XML parser:
//
//	Pass 1: build vnodeMap (vnode_id → hostname), find Grid Master, AND build
//	        memberResolver (zone → member, network → member) from ns_group + dhcp_member.
//	Pass 2: stream-count DDI objects with per-member attribution via resolver.
//
// Performance optimizations for large backups (100MB+ compressed, 2.5M+ objects):
//   - Auto-detects raw XML vs gzip+tar (supports pre-extracted onedb.xml from upload)
//   - Type-filtered parsing skips map allocation for irrelevant XML objects
//   - Reusable property buffer avoids per-object allocations
//   - Stream counting eliminates intermediate []parsedObject slice
//   - Buffered I/O (256KB) for file reads
package nios

import (
	"archive/tar"
	"bufio"
	"bytes"
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

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
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

// pass1Types contains __type values needed for the merged Pass 1:
// member discovery (virtual_node) + resolver construction (ns_group, dhcp_member, zone).
var pass1Types = map[string]struct{}{
	".com.infoblox.one.virtual_node":                   {},
	".com.infoblox.dns.ns_group_grid_primary":          {},
	".com.infoblox.dns.ns_group_forwarding_server":     {}, // forward zones use forward_address, not grid_member
	".com.infoblox.dns.dhcp_member":                    {},
	".com.infoblox.dns.zone":                           {},
	".com.infoblox.dns.member_dns_properties":          {},
	".com.infoblox.dns.member_dhcp_properties":         {},
}

// pass2Types contains __type values for Pass 2 (object counting).
// Built from XMLTypeToFamily keys at init time.
var pass2Types map[string]struct{}

func init() {
	pass2Types = make(map[string]struct{}, len(XMLTypeToFamily))
	for k := range XMLTypeToFamily {
		pass2Types[k] = struct{}{}
	}
}

// Scan implements scanner.Scanner. It performs a two-pass streaming parse of the
// NIOS backup referenced by req.Credentials["backup_path"].
//
// The backup_path may point to either a raw onedb.xml file (pre-extracted during
// upload) or a gzip+tar archive (test fixtures). Format is auto-detected.
//
// Pass 1 (merged): builds vnode_id → hostname map, identifies Grid Master, AND
// collects ns_group/dhcp_member/zone data for the member resolver.
// Pass 2: stream-counts DDI objects with per-member attribution via resolver.
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

	// ---- Pass 1 (merged): members + resolver data in a single XML pass ----
	vnodeMap := make(map[string]string)               // vnode_id → hostname
	memberProps := make(map[string]map[string]string)  // hostname → props
	gmHostname := ""

	// Resolver data collected in the same pass.
	nsGroupPrimary := make(map[string]string) // ns_group name → member oid (authoritative primary)
	nsGroupForward := make(map[string]string) // ns_group name → member oid (forward zone forwarder)
	dhcpMembers := make(map[string]string)    // network key → member oid
	zoneNSGroup := make(map[string]string)    // zone ref → ns_group name

	// Ordered slices for member_dns_properties/member_dhcp_properties positional matching.
	var vnodeOrder []string         // hostnames in virtual_node appearance order
	var dnsServiceEnabled []string  // service_enabled values from member_dns_properties
	var dhcpServiceEnabled []string // service_enabled values from member_dhcp_properties

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "pass1_start",
		Count:    0,
	})

	if err := streamOnedbXMLFiltered(backupPath, pass1Types, func(props map[string]string) {
		xmlType := props["__type"]
		switch xmlType {
		case ".com.infoblox.one.virtual_node":
			oid := props["virtual_oid"]
			hostname := props["host_name"]
			if oid == "" || hostname == "" {
				return
			}
			vnodeMap[oid] = hostname
			vnodeOrder = append(vnodeOrder, hostname)
			// Clone props for role extraction later.
			cloned := make(map[string]string, len(props))
			for k, v := range props {
				cloned[k] = v
			}
			memberProps[hostname] = cloned
			if props["is_master"] == "true" || props["is_grid_master"] == "true" {
				gmHostname = hostname
			}

		case ".com.infoblox.dns.member_dns_properties":
			dnsServiceEnabled = append(dnsServiceEnabled, props["service_enabled"])

		case ".com.infoblox.dns.member_dhcp_properties":
			dhcpServiceEnabled = append(dhcpServiceEnabled, props["service_enabled"])

		case ".com.infoblox.dns.ns_group_grid_primary":
			nsGroup := props["ns_group"]
			memberOID := props["grid_member"]
			if nsGroup != "" && memberOID != "" {
				if _, exists := nsGroupPrimary[nsGroup]; !exists {
					nsGroupPrimary[nsGroup] = memberOID
				}
			}

		case ".com.infoblox.dns.ns_group_forwarding_server":
			// Forward zones identify their responsible member via forward_address (member OID),
			// not grid_member. Collect the first occurrence per ns_group as the primary forwarder.
			nsGroup := props["ns_group"]
			memberOID := props["forward_address"]
			if nsGroup != "" && memberOID != "" {
				if _, exists := nsGroupForward[nsGroup]; !exists {
					nsGroupForward[nsGroup] = memberOID
				}
			}

		case ".com.infoblox.dns.dhcp_member":
			network := props["network"]
			memberOID := props["member"]
			if network != "" && memberOID != "" {
				if _, exists := dhcpMembers[network]; !exists {
					dhcpMembers[network] = memberOID
				}
			}

		case ".com.infoblox.dns.zone":
			zoneRef := props["zone"]
			nsGroup := props["assigned_ns_group"]
			if zoneRef != "" && nsGroup != "" {
				zoneNSGroup[zoneRef] = nsGroup
			}
		}
	}); err != nil {
		return nil, fmt.Errorf("nios: pass 1 failed: %w", err)
	}

	// Merge dns/dhcp service properties into memberProps by positional correspondence.
	// member_dns_properties and member_dhcp_properties appear in the same order as virtual_node objects.
	for i, hostname := range vnodeOrder {
		props := memberProps[hostname]
		if props == nil {
			continue
		}
		if i < len(dnsServiceEnabled) {
			props["enable_dns"] = dnsServiceEnabled[i]
		}
		if i < len(dhcpServiceEnabled) {
			props["enable_dhcp"] = dhcpServiceEnabled[i]
		}
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

	// ---- Build member resolver from Pass 1 data ----
	zoneMemberMap := make(map[string]string, len(zoneNSGroup))
	for zoneRef, nsGroup := range zoneNSGroup {
		// Try authoritative primary first, then fall back to forward zone forwarder.
		memberOID := nsGroupPrimary[nsGroup]
		if memberOID == "" {
			memberOID = nsGroupForward[nsGroup]
		}
		if memberOID != "" {
			if hostname, ok := vnodeMap[memberOID]; ok {
				zoneMemberMap[zoneRef] = hostname
			}
		}
	}

	networkMemberMap := make(map[string]string, len(dhcpMembers))
	for network, memberOID := range dhcpMembers {
		if hostname, ok := vnodeMap[memberOID]; ok {
			networkMemberMap[network] = hostname
		}
	}

	resolver := &memberResolver{
		zoneMemberMap:    zoneMemberMap,
		networkMemberMap: networkMemberMap,
		cidrEntries:      buildCIDREntries(networkMemberMap),
	}

	// ---- Pass 2: stream counting with per-object processing ----
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "pass2_start",
		Count:    0,
	})

	result := newCountResult()
	objectCount := 0

	if err := streamOnedbXMLFiltered(backupPath, pass2Types, func(props map[string]string) {
		xmlType := props["__type"]
		family, ok := XMLTypeToFamily[xmlType]
		if !ok {
			return
		}
		objectCount++
		result.processObject(family, props, props["vnode_id"], vnodeMap, gmHostname, resolver)
	}); err != nil {
		return nil, fmt.Errorf("nios: pass 2 failed: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "nios",
		Resource: "objects",
		Count:    objectCount,
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
				TokensPerUnit:    calculator.NIOSTokensPerDDIObject,
				ManagementTokens: ceilDiv(count, calculator.NIOSTokensPerDDIObject),
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
			TokensPerUnit:    calculator.NIOSTokensPerDDIObject,
			ManagementTokens: ceilDiv(count, calculator.NIOSTokensPerDDIObject),
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
				TokensPerUnit:    calculator.NIOSTokensPerActiveIP,
				ManagementTokens: ceilDiv(len(acc.memberIPSet), calculator.NIOSTokensPerActiveIP),
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
		activeIPCount := 0
		if acc, ok := result.memberAccs[hostname]; ok {
			objectCount = acc.ddiCount
			activeIPCount = len(acc.memberIPSet)
		}
		// GM gets unresolved DDI (objects not attributed to any specific member).
		if hostname == gmHostname {
			objectCount += unresolvedTotal
		}

		metrics = append(metrics, NiosServerMetric{
			MemberID:      hostname,
			MemberName:    hostname,
			Role:          role,
			QPS:           0,
			LPS:           0,
			ObjectCount:   objectCount,
			ActiveIPCount: activeIPCount,
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
	NiosFamilyDNSRecordCAA:    "DNS CAA Records",
	NiosFamilyDNSRecordNAPTR:  "DNS NAPTR Records",
	NiosFamilyDNSRecordHTTPS:  "DNS HTTPS Records",
	NiosFamilyDNSRecordSVCB:   "DNS SVCB Records",
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
	NiosFamilyDiscoveryData:    "Discovered IPs",
	NiosFamilyDNSRecordAlias:   "DNS Alias Records",
}

// familyDisplayName returns the human-readable name for a NiosFamily constant.
// Falls back to "Other DDI Objects" for unmapped families.
func familyDisplayName(family string) string {
	if name, ok := familyDisplayNames[family]; ok {
		return name
	}
	return "Other DDI Objects"
}

// propPair holds a property name/value pair for the reusable buffer in
// parseObjectStreamFiltered. Avoids map allocation for filtered-out objects.
type propPair struct {
	name, value string
}

// streamOnedbXML opens a backup file at path, finds onedb.xml, and calls
// onObject for each OBJECT element's collected PROPERTY map.
// Auto-detects raw XML vs gzip+tar format using gzip magic bytes.
func streamOnedbXML(path string, onObject func(props map[string]string)) error {
	return streamOnedbXMLFiltered(path, nil, onObject)
}

// streamOnedbXMLFiltered opens a backup file at path and streams XML objects,
// calling onObject only for objects whose __type is in typeFilter.
// If typeFilter is nil, all objects are passed through (no filtering).
//
// Auto-detects raw XML vs gzip+tar format by peeking at the first 2 bytes
// for gzip magic (0x1f 0x8b). Uses buffered I/O (256KB) for performance.
func streamOnedbXMLFiltered(path string, typeFilter map[string]struct{}, onObject func(props map[string]string)) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	br := bufio.NewReaderSize(f, 256<<10) // 256KB read buffer

	// Peek at first 2 bytes to detect gzip magic (0x1f 0x8b).
	magic, err := br.Peek(2)
	if err != nil {
		return fmt.Errorf("peek %s: %w", path, err)
	}

	if magic[0] == 0x1f && magic[1] == 0x8b {
		// Gzip+tar archive — decompress and find onedb.xml.
		gz, err := gzip.NewReader(br)
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
			return parseObjectStreamXML(tr, typeFilter, onObject)
		}
		return fmt.Errorf("onedb.xml not found in archive")
	}

	// Raw XML file — use the fast byte-level parser (10-50x faster than encoding/xml
	// for NIOS onedb.xml format where each line is one OBJECT with inline PROPERTYs).
	return parseObjectStreamFast(br, typeFilter, onObject)
}

// parseObjectStream streams XML tokens from r, calling onObject for each complete
// OBJECT element. Delegates to parseObjectStreamXML with no type filter.
func parseObjectStream(r io.Reader, onObject func(props map[string]string)) error {
	return parseObjectStreamXML(r, nil, onObject)
}

// parseObjectStreamXML is the encoding/xml based parser. Used for gzip+tar archives
// where the XML may be multi-line (e.g. test fixtures). Handles arbitrary XML formatting.
func parseObjectStreamXML(r io.Reader, typeFilter map[string]struct{}, onObject func(props map[string]string)) error {
	decoder := xml.NewDecoder(r)
	propBuf := make([]propPair, 0, 32)
	inObject := false
	skip := false

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
				skip = false
				propBuf = propBuf[:0]
			case "PROPERTY":
				if !inObject || skip {
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
				if name == "__type" && typeFilter != nil {
					if _, ok := typeFilter[value]; !ok {
						skip = true
						continue
					}
				}
				if name != "" {
					propBuf = append(propBuf, propPair{name, value})
				}
			}

		case xml.EndElement:
			if t.Name.Local == "OBJECT" && inObject {
				inObject = false
				if !skip && len(propBuf) > 0 {
					props := make(map[string]string, len(propBuf))
					for _, p := range propBuf {
						props[p.name] = p.value
					}
					onObject(props)
				}
			}
		}
	}
	return nil
}

var (
	nameTag    = []byte(`NAME="`)
	valTag     = []byte(`VALUE="`)
	objectOpen = []byte("<OBJECT>")
	objectEnd  = []byte("</OBJECT>")
)

// parseObjectStreamFast is a high-performance parser for NIOS onedb.xml files.
// Instead of using encoding/xml (which is slow for multi-million object files),
// it scans for OBJECT/PROPERTY byte patterns directly.
//
// Handles both single-line format (real NIOS backups: all PROPERTYs on one line)
// and multi-line format (test fixtures: one PROPERTY per line).
//
// ~10-50x faster than encoding/xml for typical NIOS backups (2GB, 2.5M objects).
func parseObjectStreamFast(r io.Reader, typeFilter map[string]struct{}, onObject func(props map[string]string)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 4<<20), 4<<20) // 4MB max line

	propBuf := make([]propPair, 0, 32)
	inObject := false
	skip := false

	for sc.Scan() {
		line := sc.Bytes()

		// Check for OBJECT start.
		if bytes.Contains(line, objectOpen) {
			inObject = true
			skip = false
			propBuf = propBuf[:0]
		}

		// Extract PROPERTY elements from this line.
		if inObject && !skip {
			extractProperties(line, &propBuf, typeFilter, &skip)
		}

		// Check for OBJECT end.
		if bytes.Contains(line, objectEnd) && inObject {
			inObject = false
			if !skip && len(propBuf) > 0 {
				props := make(map[string]string, len(propBuf))
				for _, p := range propBuf {
					props[p.name] = p.value
				}
				onObject(props)
			}
		}
	}
	return sc.Err()
}

// extractProperties scans a line for PROPERTY NAME="..." VALUE="..." patterns
// and appends them to propBuf. Sets *skip=true if __type is not in typeFilter.
func extractProperties(line []byte, propBuf *[]propPair, typeFilter map[string]struct{}, skip *bool) {
	pos := 0
	for {
		idx := bytes.Index(line[pos:], nameTag)
		if idx < 0 {
			break
		}
		nameStart := pos + idx + len(nameTag)

		nameEnd := bytes.IndexByte(line[nameStart:], '"')
		if nameEnd < 0 {
			break
		}
		name := string(line[nameStart : nameStart+nameEnd])
		pos = nameStart + nameEnd + 1

		valIdx := bytes.Index(line[pos:], valTag)
		if valIdx < 0 {
			break
		}
		valStart := pos + valIdx + len(valTag)

		valEnd := bytes.IndexByte(line[valStart:], '"')
		if valEnd < 0 {
			break
		}
		value := string(line[valStart : valStart+valEnd])
		pos = valStart + valEnd + 1

		// Decode XML entities if present.
		if strings.ContainsRune(value, '&') {
			value = decodeXMLEntities(value)
		}

		if name == "__type" && typeFilter != nil {
			if _, ok := typeFilter[value]; !ok {
				*skip = true
				return
			}
		}

		if name != "" {
			*propBuf = append(*propBuf, propPair{name, value})
		}
	}
}

// decodeXMLEntities replaces the 5 standard XML entities with their characters.
func decodeXMLEntities(s string) string {
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&apos;", "'")
	return s
}
