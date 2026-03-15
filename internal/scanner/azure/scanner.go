// Package azure implements scanner.Scanner for Microsoft Azure.
// It discovers Virtual Networks, subnets, DNS zones and record sets, Virtual
// Machines, Load Balancers, and Application Gateways across all resource groups
// in each selected subscription.
package azure

import (
	"context"
	"errors"
	"fmt"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	armcompute "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/compute/armcompute/v6"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/dns/armdns"
	armnetwork "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v6"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Scanner implements scanner.Scanner for Azure.
type Scanner struct{}

// New returns a ready-to-use Azure Scanner.
func New() *Scanner { return &Scanner{} }

// Scan satisfies scanner.Scanner. For each selected subscription it:
//  1. Builds an Azure credential from req.Credentials (auth_method routing)
//  2. Lists all Virtual Networks and their subnets (DDI Objects)
//  3. Lists all DNS zones and record sets (DDI Objects)
//  4. Lists all Virtual Machines (Active IPs — one IP per VM NIC)
//  5. Lists all Load Balancers and Application Gateways (Managed Assets)
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	cred, err := buildCredential(req.Credentials, req.CachedAzureCredential)
	if err != nil {
		return nil, fmt.Errorf("azure: build credential: %w", err)
	}

	var allFindings []calculator.FindingRow

	subscriptions := req.Subscriptions
	if len(subscriptions) == 0 {
		return nil, errors.New("azure: no subscriptions selected")
	}

	for _, subID := range subscriptions {
		findings, err := scanSubscription(ctx, cred, subID, publish)
		if err != nil {
			// Return partial findings + error so the orchestrator records the error
			// but keeps any findings from already-scanned subscriptions.
			return allFindings, fmt.Errorf("azure: subscription %s: %w", subID, err)
		}
		allFindings = append(allFindings, findings...)
	}

	return allFindings, nil
}

// buildCredential creates an Azure TokenCredential from the credentials map.
// Supported auth_method values: "service-principal" (default), "browser-sso".
// When cached is non-nil and auth_method is "browser-sso", the cached credential
// is returned directly, preventing a second browser popup during scan.
func buildCredential(creds map[string]string, cached azcore.TokenCredential) (azcore.TokenCredential, error) {
	switch creds["auth_method"] {
	case "browser-sso":
		if cached != nil {
			return cached, nil
		}
		// Fallback: fresh interactive login (should not happen in normal flow).
		tenantID := creds["tenant_id"]
		if tenantID == "" {
			return nil, errors.New("tenant_id is required for browser-sso")
		}
		const azureCLIClientID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
		return azidentity.NewInteractiveBrowserCredential(&azidentity.InteractiveBrowserCredentialOptions{
			TenantID: tenantID,
			ClientID: azureCLIClientID,
		})

	default:
		// service-principal (client secret) — the default and most common method.
		tenantID := creds["tenant_id"]
		clientID := creds["client_id"]
		clientSecret := creds["client_secret"]
		if tenantID == "" || clientID == "" || clientSecret == "" {
			return nil, errors.New("tenant_id, client_id, and client_secret are required")
		}
		return azidentity.NewClientSecretCredential(tenantID, clientID, clientSecret, nil)
	}
}

// scanSubscription discovers all Azure resources in a single subscription.
func scanSubscription(ctx context.Context, cred azcore.TokenCredential, subID string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	var findings []calculator.FindingRow

	// ── VNets and subnets ─────────────────────────────────────────────────────
	vnetCount, subnetCount, err := countVNetsAndSubnets(ctx, cred, subID)
	if err != nil {
		return findings, fmt.Errorf("vnets: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "vnet",
		Count:    vnetCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryDDIObjects,
		Item:             "vnet",
		Count:            vnetCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: vnetCount / calculator.TokensPerDDIObject,
	})

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "subnet",
		Count:    subnetCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryDDIObjects,
		Item:             "subnet",
		Count:            subnetCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: subnetCount / calculator.TokensPerDDIObject,
	})

	// ── DNS zones and records ─────────────────────────────────────────────────
	zoneCount, recordCount, err := countDNS(ctx, cred, subID)
	if err != nil {
		return findings, fmt.Errorf("dns: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "dns_zone",
		Count:    zoneCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryDDIObjects,
		Item:             "dns_zone",
		Count:            zoneCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: zoneCount / calculator.TokensPerDDIObject,
	})

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "dns_record",
		Count:    recordCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryDDIObjects,
		Item:             "dns_record",
		Count:            recordCount,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: recordCount / calculator.TokensPerDDIObject,
	})

	// ── Virtual Machines ──────────────────────────────────────────────────────
	vmCount, err := countVMs(ctx, cred, subID)
	if err != nil {
		return findings, fmt.Errorf("virtual_machines: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "virtual_machine",
		Count:    vmCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryActiveIPs,
		Item:             "virtual_machine",
		Count:            vmCount,
		TokensPerUnit:    calculator.TokensPerActiveIP,
		ManagementTokens: vmCount / calculator.TokensPerActiveIP,
	})

	// ── Load Balancers ────────────────────────────────────────────────────────
	lbCount, gwCount, err := countLBsAndGateways(ctx, cred, subID)
	if err != nil {
		return findings, fmt.Errorf("load_balancers: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "load_balancer",
		Count:    lbCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryManagedAssets,
		Item:             "load_balancer",
		Count:            lbCount,
		TokensPerUnit:    calculator.TokensPerManagedAsset,
		ManagementTokens: lbCount / calculator.TokensPerManagedAsset,
	})

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderAzure,
		Resource: "application_gateway",
		Count:    gwCount,
		Status:   "done",
	})
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderAzure,
		Source:           subID,
		Category:         calculator.CategoryManagedAssets,
		Item:             "application_gateway",
		Count:            gwCount,
		TokensPerUnit:    calculator.TokensPerManagedAsset,
		ManagementTokens: gwCount / calculator.TokensPerManagedAsset,
	})

	return findings, nil
}

// countVNetsAndSubnets lists all Virtual Networks and counts their subnets.
func countVNetsAndSubnets(ctx context.Context, cred azcore.TokenCredential, subID string) (vnets, subnets int, err error) {
	client, err := armnetwork.NewVirtualNetworksClient(subID, cred, nil)
	if err != nil {
		return 0, 0, err
	}

	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return vnets, subnets, err
		}
		for _, vnet := range page.Value {
			vnets++
			if vnet.Properties != nil && vnet.Properties.Subnets != nil {
				subnets += len(vnet.Properties.Subnets)
			}
		}
	}
	return vnets, subnets, nil
}

// countDNS lists all DNS zones and counts their record sets.
func countDNS(ctx context.Context, cred azcore.TokenCredential, subID string) (zones, records int, err error) {
	zonesClient, err := armdns.NewZonesClient(subID, cred, nil)
	if err != nil {
		return 0, 0, err
	}
	recordsClient, err := armdns.NewRecordSetsClient(subID, cred, nil)
	if err != nil {
		return 0, 0, err
	}

	zonePager := zonesClient.NewListPager(nil)
	for zonePager.More() {
		page, err := zonePager.NextPage(ctx)
		if err != nil {
			return zones, records, err
		}
		for _, zone := range page.Value {
			zones++
			if zone.Name == nil || zone.ID == nil {
				continue
			}
			// Extract resource group from the zone ID.
			rgName := resourceGroupFromID(*zone.ID)
			if rgName == "" {
				continue
			}
			rsPager := recordsClient.NewListAllByDNSZonePager(rgName, *zone.Name, nil)
			for rsPager.More() {
				rsPage, err := rsPager.NextPage(ctx)
				if err != nil {
					break // skip this zone's records on error
				}
				records += len(rsPage.Value)
			}
		}
	}
	return zones, records, nil
}

// countVMs lists all Virtual Machines in the subscription.
func countVMs(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armcompute.NewVirtualMachinesClient(subID, cred, nil)
	if err != nil {
		return 0, err
	}

	count := 0
	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.Value)
	}
	return count, nil
}

// countLBsAndGateways lists all Load Balancers and Application Gateways.
func countLBsAndGateways(ctx context.Context, cred azcore.TokenCredential, subID string) (lbs, gateways int, err error) {
	lbClient, err := armnetwork.NewLoadBalancersClient(subID, cred, nil)
	if err != nil {
		return 0, 0, err
	}
	gwClient, err := armnetwork.NewApplicationGatewaysClient(subID, cred, nil)
	if err != nil {
		return 0, 0, err
	}

	lbPager := lbClient.NewListAllPager(nil)
	for lbPager.More() {
		page, err := lbPager.NextPage(ctx)
		if err != nil {
			return lbs, gateways, err
		}
		lbs += len(page.Value)
	}

	gwPager := gwClient.NewListAllPager(nil)
	for gwPager.More() {
		page, err := gwPager.NextPage(ctx)
		if err != nil {
			return lbs, gateways, err
		}
		gateways += len(page.Value)
	}

	return lbs, gateways, nil
}

// resourceGroupFromID extracts the resource group name from an Azure resource ID.
// Example: /subscriptions/{sub}/resourceGroups/{rg}/providers/... → {rg}
func resourceGroupFromID(id string) string {
	const marker = "/resourceGroups/"
	idx := 0
	for i := 0; i < len(id)-len(marker); i++ {
		if id[i:i+len(marker)] == marker {
			idx = i + len(marker)
			break
		}
	}
	if idx == 0 {
		return ""
	}
	end := idx
	for end < len(id) && id[end] != '/' {
		end++
	}
	return id[idx:end]
}
