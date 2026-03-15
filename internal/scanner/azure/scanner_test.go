// Package azure — test scaffold activated in Plan 02.
// Plan 01 used a //go:build ignore gate while armprivatedns and countVMIPs
// were not yet present. Plan 02 removes the gate, installs armprivatedns,
// and renames countVMs→countVMIPs so all assertions compile.
package azure

import (
	"context"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
)

// ---- Compile-time signature assertions ----
// These assert the signatures that Plan 02 will implement or rename.
// countVMIPs uses the FUTURE name (Plan 02 renames countVMs → countVMIPs).

var _ func(string) string = resourceGroupFromID
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countVMIPs
var _ func(context.Context, azcore.TokenCredential, string) (int, int, error) = countDNS
var _ func(context.Context, azcore.TokenCredential, string) (int, int, error) = countVNetsAndSubnets
var _ func(context.Context, azcore.TokenCredential, string) (int, int, error) = countLBsAndGateways
var _ func(map[string]string, azcore.TokenCredential) (azcore.TokenCredential, error) = buildCredential

// ---- TestResourceGroupFromID ----

// TestResourceGroupFromID verifies the pure resourceGroupFromID helper with
// a range of well-formed and malformed Azure resource IDs.
func TestResourceGroupFromID(t *testing.T) {
	cases := []struct {
		name string
		id   string
		want string
	}{
		{
			name: "valid ID with mixed-case RG name",
			id:   "/subscriptions/sub-123/resourceGroups/myRG/providers/Microsoft.Network/virtualNetworks/vnet1",
			want: "myRG",
		},
		{
			name: "valid ID with hyphenated RG name",
			id:   "/subscriptions/sub/resourceGroups/rg-prod-eastus/providers/Microsoft.Compute/virtualMachines/vm1",
			want: "rg-prod-eastus",
		},
		{
			name: "ID with no resourceGroups segment",
			id:   "no-resource-group",
			want: "",
		},
		{
			name: "empty string",
			id:   "",
			want: "",
		},
		{
			name: "ID ending at RG — no trailing slash or providers",
			id:   "/subscriptions/s/resourceGroups/myRG",
			want: "myRG",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resourceGroupFromID(tc.id)
			if got != tc.want {
				t.Errorf("resourceGroupFromID(%q) = %q; want %q", tc.id, got, tc.want)
			}
		})
	}
}

// ---- TestCountNICIPs_Logic ----

// localNIC mirrors the fields of armnetwork.Interface we care about.
// Using a local struct lets us test the IP-counting algorithm without importing
// the armnetwork SDK (which is not installed yet at Wave 0).
type localNIC struct {
	attachedToVM bool
	ipCount      int
}

// countLocalNICIPs replicates the core NIC-IP counting logic:
// only NICs attached to a VM contribute their IP count to the total.
func countLocalNICIPs(nics []localNIC) int {
	total := 0
	for _, nic := range nics {
		if !nic.attachedToVM {
			continue
		}
		total += nic.ipCount
	}
	return total
}

// TestCountNICIPs_Logic verifies the IP-counting algorithm in isolation.
func TestCountNICIPs_Logic(t *testing.T) {
	cases := []struct {
		name string
		nics []localNIC
		want int
	}{
		{
			name: "3 NICs — 2 attached with 2 IPs each, 1 unattached",
			nics: []localNIC{
				{attachedToVM: true, ipCount: 2},
				{attachedToVM: true, ipCount: 2},
				{attachedToVM: false, ipCount: 5},
			},
			want: 4,
		},
		{
			name: "0 NICs",
			nics: []localNIC{},
			want: 0,
		},
		{
			name: "1 NIC attached with 0 IPConfigs",
			nics: []localNIC{
				{attachedToVM: true, ipCount: 0},
			},
			want: 0,
		},
		{
			name: "all NICs unattached",
			nics: []localNIC{
				{attachedToVM: false, ipCount: 3},
				{attachedToVM: false, ipCount: 7},
			},
			want: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := countLocalNICIPs(tc.nics)
			if got != tc.want {
				t.Errorf("countLocalNICIPs(%v) = %d; want %d", tc.nics, got, tc.want)
			}
		})
	}
}
