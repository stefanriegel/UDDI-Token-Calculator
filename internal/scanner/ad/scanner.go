// Package ad implements scanner.Scanner for Active Directory via WinRM/NTLM.
// It discovers DNS zones and records, DHCP scopes and leases, and AD user
// accounts by executing PowerShell commands on the domain controller.
package ad

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/masterzen/winrm"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

const (
	winrmPort    = 5985
	winrmTimeout = 60 * time.Second
)

// Scanner implements scanner.Scanner for Active Directory using WinRM over NTLM.
type Scanner struct{}

// New returns a ready-to-use AD Scanner.
func New() *Scanner { return &Scanner{} }

// Scan satisfies scanner.Scanner. It connects to the domain controller via
// WinRM (HTTP port 5985, NTLM auth) and runs PowerShell commands to count:
//  1. DNS zones and DNS records (DDI Objects)
//  2. DHCP scopes and active DHCP leases (DDI Objects / Active IPs)
//  3. AD user accounts (Managed Assets)
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	host := req.Credentials["host"]
	username := req.Credentials["username"]
	password := req.Credentials["password"]

	if host == "" || username == "" || password == "" {
		return nil, fmt.Errorf("ad: host, username, and password are required")
	}

	source := host

	client, err := BuildNTLMClient(host, username, password)
	if err != nil {
		return nil, fmt.Errorf("ad: build WinRM client: %w", err)
	}

	var findings []calculator.FindingRow

	// ── DNS zones and records ────────────────────────────────────────────────
	zoneCount, recordCount, err := collectDNS(ctx, client)
	if err != nil {
		// Publish error event and continue — DHCP/users may still work.
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dns_zone",
			Count:    0,
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dns_zone",
			Count:    zoneCount,
			Status:   "done",
		})
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dns_record",
			Count:    recordCount,
			Status:   "done",
		})
	}
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAD,
		Source:           source,
		Category:         calculator.CategoryDDIObjects,
		Item:             "dns_zone",
		Count:            zoneCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: ceilDiv(zoneCount, calculator.TokensPerDDIObject),
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAD,
		Source:           source,
		Category:         calculator.CategoryDDIObjects,
		Item:             "dns_record",
		Count:            recordCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: ceilDiv(recordCount, calculator.TokensPerDDIObject),
	})

	// ── DHCP scopes and leases ───────────────────────────────────────────────
	scopeCount, leaseCount, err := collectDHCP(ctx, client)
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dhcp_scope",
			Count:    0,
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dhcp_scope",
			Count:    scopeCount,
			Status:   "done",
		})
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "dhcp_lease",
			Count:    leaseCount,
			Status:   "done",
		})
	}
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAD,
		Source:           source,
		Category:         calculator.CategoryDDIObjects,
		Item:             "dhcp_scope",
		Count:            scopeCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: ceilDiv(scopeCount, calculator.TokensPerDDIObject),
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAD,
		Source:           source,
		Category:         calculator.CategoryActiveIPs,
		Item:             "dhcp_lease",
		Count:            leaseCount,
		TokensPerUnit:    calculator.TokensPerActiveIP,
		ManagementTokens: ceilDiv(leaseCount, calculator.TokensPerActiveIP),
	})

	// ── AD user accounts ─────────────────────────────────────────────────────
	userCount, err := collectUsers(ctx, client)
	if err != nil {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "user_account",
			Count:    0,
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAD,
			Resource: "user_account",
			Count:    userCount,
			Status:   "done",
		})
	}
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAD,
		Source:           source,
		Category:         calculator.CategoryManagedAssets,
		Item:             "user_account",
		Count:            userCount,
		TokensPerUnit:    calculator.TokensPerManagedAsset,
		ManagementTokens: ceilDiv(userCount, calculator.TokensPerManagedAsset),
	})

	return findings, nil
}

// BuildNTLMClient constructs a WinRM client using NTLM with message-level encryption
// (SPNEGO session encryption, HTTP port 5985). Windows DCs require WinRM message
// encryption by default — ClientNTLM (raw NTLM, no encryption) will be rejected with
// a 401 or 500. winrm.NewEncryption("ntlm") uses bodgit/ntlmssp which implements the
// full NTLM + SPNEGO multipart/encrypted framing that DCs expect.
// Kerberos requires a domain-joined machine and is out of scope for this tool.
func BuildNTLMClient(host, username, password string) (*winrm.Client, error) {
	endpoint := winrm.NewEndpoint(host, winrmPort, false, false, nil, nil, nil, winrmTimeout)
	params := winrm.DefaultParameters
	enc, err := winrm.NewEncryption("ntlm")
	if err != nil {
		return nil, fmt.Errorf("winrm encryption init: %w", err)
	}
	params.TransportDecorator = func() winrm.Transporter { return enc }
	return winrm.NewClientWithParameters(endpoint, username, password, params)
}

// runPS executes a PowerShell script via WinRM and returns stdout.
// Returns an error if the exit code is non-zero.
func runPS(ctx context.Context, client *winrm.Client, script string) (string, error) {
	var stdout, stderr bytes.Buffer
	exitCode, err := client.RunWithContext(ctx, winrm.Powershell(script), &stdout, &stderr)
	if err != nil {
		return "", fmt.Errorf("WinRM run error: %w", err)
	}
	if exitCode != 0 {
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = strings.TrimSpace(stdout.String())
		}
		return "", fmt.Errorf("PowerShell exited %d: %s", exitCode, errText)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// runPSJSON executes a PowerShell script and parses the JSON output.
// Returns nil if the output is empty.
func runPSJSON(ctx context.Context, client *winrm.Client, script string) (interface{}, error) {
	text, err := runPS(ctx, client, script)
	if err != nil {
		return nil, err
	}
	if text == "" {
		return nil, nil
	}
	var result interface{}
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		preview := text
		if len(preview) > 200 {
			preview = preview[:200]
		}
		return nil, fmt.Errorf("PowerShell output is not valid JSON: %s", preview)
	}
	return result, nil
}

// toObjectList normalises arbitrary JSON into a []map[string]interface{}.
// Handles both JSON objects (wraps in slice) and JSON arrays.
func toObjectList(payload interface{}) []map[string]interface{} {
	if payload == nil {
		return nil
	}
	switch v := payload.(type) {
	case []interface{}:
		result := make([]map[string]interface{}, 0, len(v))
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				result = append(result, m)
			}
		}
		return result
	case map[string]interface{}:
		return []map[string]interface{}{v}
	}
	return nil
}

// psQuote escapes a string for single-quote use in PowerShell.
func psQuote(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// collectDNS runs Get-DnsServerZone and Get-DnsServerResourceRecord and
// returns (zoneCount, recordCount, error).
func collectDNS(ctx context.Context, client *winrm.Client) (zones, records int, err error) {
	// List all DNS zones.
	const zoneScript = `Get-DnsServerZone -ErrorAction Stop | ` +
		`Select-Object @{Name='ZoneName';Expression={$_.ZoneName}} | ` +
		`ConvertTo-Json -Compress`

	zonePayload, err := runPSJSON(ctx, client, zoneScript)
	if err != nil {
		return 0, 0, fmt.Errorf("dns zones: %w", err)
	}

	zoneObjects := toObjectList(zonePayload)
	zones = len(zoneObjects)

	// For each zone, count the resource records.
	for _, zone := range zoneObjects {
		zoneName, _ := zone["ZoneName"].(string)
		if zoneName == "" {
			continue
		}

		escaped := psQuote(zoneName)
		recordScript := fmt.Sprintf(
			`Get-DnsServerResourceRecord -ZoneName '%s' -ErrorAction Stop | `+
				`Select-Object @{Name='RecordType';Expression={($_.RecordType).ToString()}} | `+
				`ConvertTo-Json -Compress`,
			escaped,
		)

		recPayload, recErr := runPSJSON(ctx, client, recordScript)
		if recErr != nil {
			// Skip zones that fail (e.g. reverse zones with restricted access).
			continue
		}
		records += len(toObjectList(recPayload))
	}

	return zones, records, nil
}

// collectDHCP runs Get-DhcpServerv4Scope and Get-DhcpServerv4Lease and
// returns (scopeCount, leaseCount, error).
func collectDHCP(ctx context.Context, client *winrm.Client) (scopes, leases int, err error) {
	const scopeScript = `Get-DhcpServerv4Scope -ErrorAction Stop | ` +
		`Select-Object @{Name='ScopeId';Expression={$_.ScopeId.IPAddressToString}} | ` +
		`ConvertTo-Json -Compress`

	scopePayload, err := runPSJSON(ctx, client, scopeScript)
	if err != nil {
		return 0, 0, fmt.Errorf("dhcp scopes: %w", err)
	}

	scopeObjects := toObjectList(scopePayload)
	scopes = len(scopeObjects)

	for _, scope := range scopeObjects {
		scopeID, _ := scope["ScopeId"].(string)
		if scopeID == "" {
			continue
		}

		escaped := psQuote(scopeID)
		leaseScript := fmt.Sprintf(
			`Get-DhcpServerv4Lease -ScopeId '%s' -ErrorAction Stop | `+
				`Select-Object @{Name='IPAddress';Expression={$_.IPAddress.IPAddressToString}} | `+
				`ConvertTo-Json -Compress`,
			escaped,
		)

		leasePayload, leaseErr := runPSJSON(ctx, client, leaseScript)
		if leaseErr != nil {
			continue
		}
		leases += len(toObjectList(leasePayload))
	}

	return scopes, leases, nil
}

// collectUsers runs Get-ADUser -Filter * and returns (userCount, error).
func collectUsers(ctx context.Context, client *winrm.Client) (int, error) {
	const userScript = `Get-ADUser -Filter * -ErrorAction Stop | ` +
		`Select-Object @{Name='SID';Expression={if ($_.SID) { $_.SID.Value } else { $null }}} | ` +
		`ConvertTo-Json -Compress -Depth 4`

	payload, err := runPSJSON(ctx, client, userScript)
	if err != nil {
		return 0, fmt.Errorf("ad users: %w", err)
	}

	return len(toObjectList(payload)), nil
}

// ceilDiv computes ceiling(n / d). Returns 0 if n is 0.
func ceilDiv(n, d int) int {
	if n == 0 || d == 0 {
		return 0
	}
	return (n + d - 1) / d
}
