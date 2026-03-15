// Package azure — test scaffold activated in Plan 02.
// Plan 01 used a //go:build ignore gate while armprivatedns and countVMIPs
// were not yet present. Plan 02 removes the gate, installs armprivatedns,
// and renames countVMs→countVMIPs so all assertions compile.
package azure

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/checkpoint"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// ---- Compile-time signature assertions ----
// These assert the signatures of all count functions and helpers.

var _ func(string) string = resourceGroupFromID
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countVMIPs
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countPublicIPs
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countNATGateways
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countAzureFirewalls
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countPrivateEndpoints
var _ func(context.Context, azcore.TokenCredential, string) (int, error) = countRouteTables
var _ func(context.Context, azcore.TokenCredential, string) (int, map[string]int, error) = countDNS
var _ func(context.Context, azcore.TokenCredential, string) (int, int, []string, error) = countVNetsAndSubnets
var _ func(context.Context, azcore.TokenCredential, string) (int, int, int, error) = countLBsAndGateways
var _ func(context.Context, azcore.TokenCredential, string, []string) (int, int, error) = countVNetGatewayIPs
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

// ---- TestScanAllSubscriptions_FanOut ----

// TestScanAllSubscriptions_FanOut verifies the parallel fan-out orchestration:
// (a) multiple subscriptions are scanned concurrently,
// (b) subscription_progress events are emitted per subscription (scanning, complete/error),
// (c) a failing subscription does not abort others.
func TestScanAllSubscriptions_FanOut(t *testing.T) {
	// Save and restore the real scanSubscriptionFunc.
	origFn := scanSubscriptionFunc
	t.Cleanup(func() { scanSubscriptionFunc = origFn })

	// Stub: sub-1 succeeds with 2 findings, sub-2 fails, sub-3 succeeds with 1 finding.
	scanSubscriptionFunc = func(ctx context.Context, cred azcore.TokenCredential, subID, displayName string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
		switch subID {
		case "sub-2":
			return nil, fmt.Errorf("simulated failure for %s", subID)
		case "sub-1":
			return []calculator.FindingRow{
				{Provider: "azure", Source: displayName, Item: "vnet", Count: 3},
				{Provider: "azure", Source: displayName, Item: "subnet", Count: 5},
			}, nil
		case "sub-3":
			return []calculator.FindingRow{
				{Provider: "azure", Source: displayName, Item: "vnet", Count: 1},
			}, nil
		default:
			return nil, nil
		}
	}

	ctx := context.Background()
	subscriptions := []string{"sub-1", "sub-2", "sub-3"}

	var mu sync.Mutex
	var events []scanner.Event
	publish := func(e scanner.Event) {
		mu.Lock()
		events = append(events, e)
		mu.Unlock()
	}

	// No real credential needed — the stub ignores it.
	findings, err := scanAllSubscriptions(ctx, nil, subscriptions, 2, "", publish)
	if err != nil {
		t.Fatalf("scanAllSubscriptions returned unexpected error: %v", err)
	}

	// (a) Findings from sub-1 and sub-3 should be present (3 total rows).
	if len(findings) != 3 {
		t.Errorf("expected 3 findings, got %d", len(findings))
	}

	// (b) Check subscription_progress events.
	progressEvents := make(map[string][]string) // subID -> list of statuses
	for _, e := range events {
		if e.Type == "subscription_progress" {
			for _, sub := range subscriptions {
				if containsSubstring(e.Message, sub) {
					progressEvents[sub] = append(progressEvents[sub], e.Status)
					break
				}
			}
		}
	}

	// Each subscription should have a "scanning" event.
	for _, sub := range subscriptions {
		statuses := progressEvents[sub]
		if !containsStatus(statuses, "scanning") {
			t.Errorf("subscription %s missing 'scanning' progress event; got %v", sub, statuses)
		}
	}

	// sub-1 and sub-3 should have "complete".
	for _, sub := range []string{"sub-1", "sub-3"} {
		if !containsStatus(progressEvents[sub], "complete") {
			t.Errorf("subscription %s missing 'complete' progress event; got %v", sub, progressEvents[sub])
		}
	}

	// sub-2 should have "error".
	if !containsStatus(progressEvents["sub-2"], "error") {
		t.Errorf("subscription sub-2 missing 'error' progress event; got %v", progressEvents["sub-2"])
	}

	// (c) Verify that sub-2's failure did NOT prevent sub-1 and sub-3 from completing.
	foundSub1 := false
	foundSub3 := false
	for _, f := range findings {
		if f.Source == "sub-1" {
			foundSub1 = true
		}
		if f.Source == "sub-3" {
			foundSub3 = true
		}
	}
	if !foundSub1 {
		t.Error("sub-1 findings missing — failure in sub-2 aborted sub-1")
	}
	if !foundSub3 {
		t.Error("sub-3 findings missing — failure in sub-2 aborted sub-3")
	}
}

// containsSubstring checks if s contains substr.
func containsSubstring(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

// containsStatus checks if a string slice contains a specific value.
func containsStatus(statuses []string, target string) bool {
	for _, s := range statuses {
		if s == target {
			return true
		}
	}
	return false
}

// ---- TestExtractResourceGroupsFromVNetIDs ----

// TestExtractResourceGroupsFromVNetIDs verifies that unique resource group names
// are correctly extracted from VNet resource IDs for VNet gateway enumeration.
func TestExtractResourceGroupsFromVNetIDs(t *testing.T) {
	cases := []struct {
		name    string
		ids     []string
		wantRGs []string
	}{
		{
			name: "two VNets in same RG",
			ids: []string{
				"/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/virtualNetworks/vnet1",
				"/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/virtualNetworks/vnet2",
			},
			wantRGs: []string{"rg-a"},
		},
		{
			name: "VNets in different RGs",
			ids: []string{
				"/subscriptions/sub/resourceGroups/rg-a/providers/Microsoft.Network/virtualNetworks/vnet1",
				"/subscriptions/sub/resourceGroups/rg-b/providers/Microsoft.Network/virtualNetworks/vnet2",
			},
			wantRGs: []string{"rg-a", "rg-b"},
		},
		{
			name:    "empty list",
			ids:     []string{},
			wantRGs: nil,
		},
		{
			name:    "malformed ID without resourceGroups",
			ids:     []string{"not-a-real-id"},
			wantRGs: nil,
		},
		{
			name: "mix of valid and invalid",
			ids: []string{
				"/subscriptions/sub/resourceGroups/rg-x/providers/Microsoft.Network/virtualNetworks/v1",
				"bad-id",
			},
			wantRGs: []string{"rg-x"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Extract unique RG names using the same algorithm as countVNetGatewayIPs.
			seen := make(map[string]bool, len(tc.ids))
			var rgNames []string
			for _, id := range tc.ids {
				rg := resourceGroupFromID(id)
				if rg != "" && !seen[rg] {
					seen[rg] = true
					rgNames = append(rgNames, rg)
				}
			}

			if len(rgNames) != len(tc.wantRGs) {
				t.Fatalf("got %d RGs %v; want %d %v", len(rgNames), rgNames, len(tc.wantRGs), tc.wantRGs)
			}
			for i, rg := range rgNames {
				if rg != tc.wantRGs[i] {
					t.Errorf("rgNames[%d] = %q; want %q", i, rg, tc.wantRGs[i])
				}
			}
		})
	}
}

// TestScanAllSubscriptions_CheckpointResume verifies that scanAllSubscriptions
// skips subscriptions that were already completed in a prior checkpoint and
// prepends their saved findings.
func TestScanAllSubscriptions_CheckpointResume(t *testing.T) {
	// Save and restore the real scanSubscriptionFunc.
	origFn := scanSubscriptionFunc
	t.Cleanup(func() { scanSubscriptionFunc = origFn })

	// Track which subscription IDs are actually scanned.
	var mu sync.Mutex
	scannedIDs := make(map[string]bool)
	scanSubscriptionFunc = func(ctx context.Context, cred azcore.TokenCredential, subID, displayName string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
		mu.Lock()
		scannedIDs[subID] = true
		mu.Unlock()
		return []calculator.FindingRow{
			{Provider: "azure", Source: displayName, Item: "vnet", Count: 2},
		}, nil
	}

	// Pre-populate checkpoint with sub-1 already completed.
	cpDir := t.TempDir()
	cpPath := filepath.Join(cpDir, "checkpoint-azure.json")
	cp := checkpoint.New(cpPath, "", "azure")
	_ = cp.AddUnit(checkpoint.CompletedUnit{
		ID:          "sub-1",
		Name:        "sub-1",
		CompletedAt: time.Now(),
		Findings: []calculator.FindingRow{
			{Provider: "azure", Source: "sub-1", Item: "vnet", Count: 5},
			{Provider: "azure", Source: "sub-1", Item: "subnet", Count: 10},
		},
	})

	ctx := context.Background()
	subscriptions := []string{"sub-1", "sub-2", "sub-3"}

	var events []scanner.Event
	var eventMu sync.Mutex
	publish := func(e scanner.Event) {
		eventMu.Lock()
		events = append(events, e)
		eventMu.Unlock()
	}

	findings, err := scanAllSubscriptions(ctx, nil, subscriptions, 2, cpPath, publish)
	if err != nil {
		t.Fatalf("scanAllSubscriptions: %v", err)
	}

	// (a) sub-1 should NOT have been scanned (it was in the checkpoint).
	if scannedIDs["sub-1"] {
		t.Error("sub-1 was scanned but should have been skipped (already in checkpoint)")
	}

	// (b) sub-2 and sub-3 should have been scanned.
	if !scannedIDs["sub-2"] {
		t.Error("sub-2 was not scanned")
	}
	if !scannedIDs["sub-3"] {
		t.Error("sub-3 was not scanned")
	}

	// (c) Findings should include pre-loaded checkpoint data (2 rows from sub-1) + fresh scans.
	if len(findings) < 4 {
		t.Errorf("expected at least 4 findings (2 from checkpoint + 2 from scanning), got %d", len(findings))
	}

	// Verify pre-loaded findings are present.
	foundCheckpointed := false
	for _, f := range findings {
		if f.Source == "sub-1" && f.Item == "subnet" && f.Count == 10 {
			foundCheckpointed = true
		}
	}
	if !foundCheckpointed {
		t.Error("checkpoint findings for sub-1 not found in results")
	}

	// (d) Verify checkpoint_loaded event was published.
	hasLoaded := false
	for _, e := range events {
		if e.Type == "checkpoint_loaded" {
			hasLoaded = true
		}
	}
	if !hasLoaded {
		t.Error("expected checkpoint_loaded event")
	}
}
