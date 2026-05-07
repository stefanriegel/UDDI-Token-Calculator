//go:build ignore

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/masterzen/winrm"
)

func buildClient(host, username, password string) (*winrm.Client, error) {
	endpoint := winrm.NewEndpoint(host, 5985, false, false, nil, nil, nil, 60*time.Second)
	params := winrm.DefaultParameters
	enc, err := winrm.NewEncryption("ntlm")
	if err != nil {
		return nil, err
	}
	params.TransportDecorator = func() winrm.Transporter { return enc }
	return winrm.NewClientWithParameters(endpoint, username, password, params)
}

func runPS(ctx context.Context, client *winrm.Client, script string) (string, error) {
	var out, errBuf bytes.Buffer
	exit, err := client.RunWithContext(ctx, winrm.Powershell(script), &out, &errBuf)
	if err != nil {
		return "", fmt.Errorf("WinRM: %w", err)
	}
	if exit != 0 {
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		return "", fmt.Errorf("exit %d: %s", exit, msg)
	}
	return strings.TrimSpace(out.String()), nil
}

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
		return nil, fmt.Errorf("JSON: %s — raw: %s", err, preview)
	}
	return result, nil
}

func toObjects(payload interface{}) []map[string]interface{} {
	if payload == nil {
		return nil
	}
	switch v := payload.(type) {
	case []interface{}:
		var out []map[string]interface{}
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				out = append(out, m)
			}
		}
		return out
	case map[string]interface{}:
		return []map[string]interface{}{v}
	}
	return nil
}

func main() {
	host := "20.86.165.37"
	password := "fUaGvQLKcJnFStvO1fAa1!"
	username := `CORP\labadmin`

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client, err := buildClient(host, username, password)
	if err != nil {
		fmt.Println("build:", err)
		return
	}

	// Probe
	out, err := runPS(ctx, client, `$PSVersionTable.PSVersion.Major`)
	if err != nil {
		fmt.Println("probe FAIL:", err)
		return
	}
	fmt.Println("PS version:", out)

	// DNS zones
	fmt.Println("\n=== DNS zones ===")
	zonePayload, err := runPSJSON(ctx, client,
		`Get-DnsServerZone -ErrorAction Stop | `+
			`Select-Object @{Name='ZoneName';Expression={$_.ZoneName}} | `+
			`ConvertTo-Json -Compress`)
	if err != nil {
		fmt.Println("FAIL:", err)
	} else {
		zones := toObjects(zonePayload)
		fmt.Printf("Zone count: %d\n", len(zones))
		totalRecords := 0
		for _, z := range zones {
			name, _ := z["ZoneName"].(string)
			if name == "" {
				continue
			}
			escaped := strings.ReplaceAll(name, "'", "''")
			recPayload, recErr := runPSJSON(ctx, client, fmt.Sprintf(
				`Get-DnsServerResourceRecord -ZoneName '%s' -ErrorAction Stop | `+
					`Select-Object @{Name='RecordType';Expression={($_.RecordType).ToString()}} | `+
					`ConvertTo-Json -Compress`, escaped))
			if recErr != nil {
				fmt.Printf("  Zone %-40s  ERROR: %v\n", name, recErr)
				continue
			}
			n := len(toObjects(recPayload))
			fmt.Printf("  Zone %-40s  records: %d\n", name, n)
			totalRecords += n
		}
		fmt.Printf("Total DNS records: %d\n", totalRecords)
	}

	// DHCP
	fmt.Println("\n=== DHCP scopes ===")
	scopePayload, err := runPSJSON(ctx, client,
		`Get-DhcpServerv4Scope -ErrorAction Stop | `+
			`Select-Object @{Name='ScopeId';Expression={$_.ScopeId.IPAddressToString}} | `+
			`ConvertTo-Json -Compress`)
	if err != nil {
		fmt.Println("FAIL:", err)
	} else {
		scopes := toObjects(scopePayload)
		fmt.Printf("Scope count: %d\n", len(scopes))
		totalLeases := 0
		for _, s := range scopes {
			sid, _ := s["ScopeId"].(string)
			escaped := strings.ReplaceAll(sid, "'", "''")
			leasePayload, lErr := runPSJSON(ctx, client, fmt.Sprintf(
				`Get-DhcpServerv4Lease -ScopeId '%s' -ErrorAction Stop | `+
					`Select-Object @{Name='IPAddress';Expression={$_.IPAddress.IPAddressToString}} | `+
					`ConvertTo-Json -Compress`, escaped))
			if lErr != nil {
				fmt.Printf("  Scope %s  ERROR: %v\n", sid, lErr)
				continue
			}
			n := len(toObjects(leasePayload))
			fmt.Printf("  Scope %-20s  leases: %d\n", sid, n)
			totalLeases += n
		}
		fmt.Printf("Total leases: %d\n", totalLeases)
	}

	// AD users
	fmt.Println("\n=== AD users ===")
	userPayload, err := runPSJSON(ctx, client,
		`Get-ADUser -Filter * -ErrorAction Stop | `+
			`Select-Object @{Name='SID';Expression={if ($_.SID) { $_.SID.Value } else { $null }}} | `+
			`ConvertTo-Json -Compress -Depth 4`)
	if err != nil {
		fmt.Println("FAIL:", err)
	} else {
		users := toObjects(userPayload)
		fmt.Printf("User count: %d\n", len(users))
	}
}
