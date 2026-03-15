// Package nios implements the NIOS backup scanner for Phase 10.
// scanner.go replaces the Phase 9 stub with a real two-pass streaming XML parser.
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

// Scan implements scanner.Scanner. It performs a two-pass streaming parse of the
// NIOS backup archive referenced by req.Credentials["backup_path"].
//
// Pass 1: builds vnode_id → hostname map and identifies the Grid Master.
// Pass 2: counts DDI objects, active lease IPs, and managed assets per member.
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
	vnodeMap := make(map[string]string) // vnode_id → hostname
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
		if props["is_grid_master"] == "true" {
			gmHostname = hostname
		}
	}); err != nil {
		return nil, fmt.Errorf("nios: pass 1 failed: %w", err)
	}

	// gmHostname fallback: if is_grid_master was not found in any member,
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

	result := countObjects(objects, vnodeMap, gmHostname)

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

	// Emit per-family DDI rows with human-readable names (grid-level, attributed to GM).
	// All DDI objects are grid-level in the current NIOS model (only LEASE is member-scoped,
	// and LEASE is not a DDI family). familyCounts contains DDI-adjusted values (HOST_OBJECT
	// uses +2/+3 expansion, matching Python per_family_ddi).
	if result.gridDDI > 0 {
		for family, count := range result.familyCounts {
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
	}

	// Per-member DDI: emit rows for any member that has DDI objects attributed to it.
	// In the current NIOS model, per-member DDI is always 0 (only LEASE is member-scoped
	// and LEASE is not a DDI family), but this handles future member-scoped DDI families.
	for hostname, acc := range result.memberAccs {
		if acc.ddiCount > 0 {
			rows = append(rows, calculator.FindingRow{
				Provider:         "nios",
				Source:           hostname,
				Category:         calculator.CategoryDDIObjects,
				Item:             "DDI Objects (Total)",
				Count:            acc.ddiCount,
				TokensPerUnit:    calculator.TokensPerDDIObject,
				ManagementTokens: ceilDiv(acc.ddiCount, calculator.TokensPerDDIObject),
			})
		}
	}

	// Grid-level Active IPs — count ALL unique IPs across all sources:
	// leases, fixed addresses, host addresses, network reservations, and discovery data.
	// Uses globalIPSet which deduplicates across all sources to avoid double-counting.
	if len(result.globalIPSet) > 0 {
		rows = append(rows, calculator.FindingRow{
			Provider:         "nios",
			Source:           gmHostname,
			Category:         calculator.CategoryActiveIPs,
			Item:             "NIOS Active IPs (All Sources)",
			Count:            len(result.globalIPSet),
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: ceilDiv(len(result.globalIPSet), calculator.TokensPerActiveIP),
		})
	}

	// Per-member lease IPs (informational — global row already covers token calc).
	// The dedup test expects total Active IP count <= 3 (fixture has 3 unique leases).
	// We emit only the global row to avoid double-counting in the sum.

	// NIOS Grid Members are NOT counted as managed assets.
	// They are part of the NIOS grid licensing, not Universal DDI managed assets.

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
// ObjectCount for GM includes grid-level DDI (since all DDI is grid-level in current NIOS model).
// ObjectCount for non-GM members includes their per-member DDI (currently 0) plus lease count.
func buildMetrics(
	vnodeMap map[string]string,
	memberProps map[string]map[string]string,
	result countResult,
	gmHostname string,
) []NiosServerMetric {
	metrics := make([]NiosServerMetric, 0, len(vnodeMap))
	for _, hostname := range vnodeMap {
		props := memberProps[hostname]
		role := extractServiceRole(props)

		objectCount := 0
		if acc, ok := result.memberAccs[hostname]; ok {
			objectCount = acc.ddiCount
		}
		// GM gets grid-level DDI (all DDI is grid-level in current NIOS model).
		if hostname == gmHostname {
			objectCount += result.gridDDI
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

// ceilDiv computes ceiling(n / d). Returns 0 if n is 0.
func ceilDiv(n, d int) int {
	if n == 0 {
		return 0
	}
	return (n + d - 1) / d
}

// streamOnedbXML opens the gzip+tar backup at path, finds onedb.xml, and calls
// onObject for each OBJECT element's collected PROPERTY map.
// It handles the file open/close lifecycle internally for two-pass streaming.
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
