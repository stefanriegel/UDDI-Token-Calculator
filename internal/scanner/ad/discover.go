// Package ad — forest-wide server discovery.
//
// DiscoverForest connects to a seed Windows DC via WinRM and runs two PowerShell
// probes to enumerate every domain controller and every DHCP server registered in
// the Active Directory forest.  Results are deduplicated and tagged with their
// roles ("DC", "DNS", "DHCP") so the wizard can present a one-click "add all" UX.
//
// # Discovery strategy
//
//  1. Get-ADForest enumerates all domains in the forest.
//  2. Get-ADDomainController -Filter * is called per domain to collect every DC.
//     Each DC is assumed to also carry the DNS Server role (standard for AD-integrated DNS).
//  3. Get-DhcpServerInDC queries the directory service for all authorised DHCP servers
//     (including member servers that are not DCs).
//
// Both probes are run on the same seed DC; if the AD module is absent (e.g. a
// pure DHCP server) the DC list gracefully degrades to an empty slice while the
// DHCP probe still succeeds, and vice-versa.
package ad

import (
	"context"
	"fmt"
	"strings"
)

// DiscoveredServer describes one server found during forest discovery.
type DiscoveredServer struct {
	// Hostname is the fully-qualified or short DNS name of the server.
	Hostname string `json:"hostname"`
	// IP is the IPv4 address as reported by the domain controller.
	IP string `json:"ip,omitempty"`
	// Domain is the domain the server belongs to (DCs only; empty for standalone DHCP servers).
	Domain string `json:"domain,omitempty"`
	// Roles lists the server roles detected: "DC", "DNS", "DHCP".
	Roles []string `json:"roles"`
}

// ForestDiscovery holds the outcome of a single DiscoverForest call.
type ForestDiscovery struct {
	// DomainControllers contains every DC found across all forest domains.
	// Each DC is assumed to carry the DNS Server role.
	DomainControllers []DiscoveredServer `json:"domainControllers"`
	// DHCPServers lists all servers registered via netlogon/DhcpRoot in AD.
	// Overlaps with DomainControllers when a DC also runs DHCP.
	DHCPServers []DiscoveredServer `json:"dhcpServers"`
	// ForestName is the root domain name of the forest (empty on probe failure).
	ForestName string `json:"forestName,omitempty"`
	// Errors holds non-fatal per-probe error messages.
	Errors []string `json:"errors,omitempty"`
}

// DiscoverForest connects to host with the given credentials and enumerates the
// AD forest's domain controllers and DHCP servers.  It never returns a hard error
// for partial failures — individual probe errors are collected in ForestDiscovery.Errors
// so the caller can surface them as warnings rather than aborting.
//
// clientOpts are forwarded to BuildNTLMClient unchanged (e.g. WithHTTPS,
// WithInsecureSkipVerify).
func DiscoverForest(ctx context.Context, host, username, password string, opts ...ClientOption) (*ForestDiscovery, error) {
	client, err := BuildNTLMClient(host, username, password, opts...)
	if err != nil {
		return nil, fmt.Errorf("ad discover: WinRM client: %w", err)
	}

	result := &ForestDiscovery{}

	// ── 1. DC enumeration ────────────────────────────────────────────────────
	//
	// Get-ADForest returns the forest object whose Domains property lists every
	// domain DNS name.  We iterate and call Get-ADDomainController for each.
	// The whole block is wrapped in a try/catch so that an absent AD module
	// (non-DC seeds) degrades gracefully.
	const dcScript = `
try {
    Import-Module ActiveDirectory -ErrorAction Stop
    $forest = Get-ADForest -ErrorAction Stop
    $out = @()
    foreach ($dom in $forest.Domains) {
        try {
            $dcs = Get-ADDomainController -Filter * -Server $dom -ErrorAction Stop
            foreach ($dc in $dcs) {
                $out += [PSCustomObject]@{
                    HostName    = $dc.HostName
                    IPv4Address = $dc.IPv4Address
                    Domain      = $dom
                }
            }
        } catch { <# skip inaccessible domain #> }
    }
    $forestName = $forest.Name
    [PSCustomObject]@{
        ForestName        = $forestName
        DomainControllers = $out
    } | ConvertTo-Json -Compress -Depth 6
} catch {
    Write-Output '{"ForestName":"","DomainControllers":[]}'
}
`

	dcPayload, dcErr := runPSJSON(ctx, client, dcScript)
	if dcErr != nil {
		result.Errors = append(result.Errors, "DC enumeration: "+dcErr.Error())
	} else if dcPayload != nil {
		top, ok := dcPayload.(map[string]interface{})
		if ok {
			if fn, _ := top["ForestName"].(string); fn != "" {
				result.ForestName = fn
			}
			if dcList, ok := top["DomainControllers"]; ok {
				for _, raw := range toObjectList(dcList) {
					hostname := strings.TrimSpace(str(raw["HostName"]))
					if hostname == "" {
						continue
					}
					srv := DiscoveredServer{
						Hostname: hostname,
						IP:       strings.TrimSpace(str(raw["IPv4Address"])),
						Domain:   strings.TrimSpace(str(raw["Domain"])),
						Roles:    []string{"DC", "DNS"},
					}
					result.DomainControllers = append(result.DomainControllers, srv)
				}
			}
		}
	}

	// ── 2. DHCP server enumeration ────────────────────────────────────────────
	//
	// Get-DhcpServerInDC queries the CN=NetServices container in AD and returns
	// all servers that have been authorised to provide DHCP on the network.
	// This includes both DC-DHCP co-located servers and standalone DHCP servers.
	const dhcpScript = `
try {
    Import-Module DHCPServer -ErrorAction SilentlyContinue
    Get-DhcpServerInDC -ErrorAction Stop |
        Select-Object @{N='HostName';E={$_.DnsName}},
                      @{N='IPv4Address';E={$_.IPAddress.IPAddressToString}} |
        ConvertTo-Json -Compress
} catch {
    Write-Output '[]'
}
`

	dhcpPayload, dhcpErr := runPSJSON(ctx, client, dhcpScript)
	if dhcpErr != nil {
		result.Errors = append(result.Errors, "DHCP server enumeration: "+dhcpErr.Error())
	} else if dhcpPayload != nil {
		for _, raw := range toObjectList(dhcpPayload) {
			hostname := strings.TrimSpace(str(raw["HostName"]))
			if hostname == "" {
				continue
			}
			srv := DiscoveredServer{
				Hostname: hostname,
				IP:       strings.TrimSpace(str(raw["IPv4Address"])),
				Roles:    []string{"DHCP"},
			}
			// Annotate if this DHCP server is also a DC.
			for i, dc := range result.DomainControllers {
				if strings.EqualFold(dc.Hostname, hostname) {
					result.DomainControllers[i].Roles = appendRole(result.DomainControllers[i].Roles, "DHCP")
					// Don't add a duplicate entry in DHCPServers for this one.
					hostname = ""
					break
				}
			}
			if hostname != "" {
				result.DHCPServers = append(result.DHCPServers, srv)
			}
		}
	}

	return result, nil
}

// appendRole adds role to roles if not already present.
func appendRole(roles []string, role string) []string {
	for _, r := range roles {
		if r == role {
			return roles
		}
	}
	return append(roles, role)
}
