// Package azure implements scanner.Scanner for Microsoft Azure.
// It discovers Virtual Networks, subnets, DNS zones and record sets, Virtual
// Machines, Load Balancers, and Application Gateways across all resource groups
// in each selected subscription.
package azure

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/dns/armdns"
	armnetwork "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v6"
	armprivatedns "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/privatedns/armprivatedns"
	armsubscriptions "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armsubscriptions"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/cloudutil"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// maxConcurrentSubscriptions is the default concurrency for multi-subscription fan-out.
const maxConcurrentSubscriptions = 5

// Scanner implements scanner.Scanner for Azure.
type Scanner struct{}

// New returns a ready-to-use Azure Scanner.
func New() *Scanner { return &Scanner{} }

// Scan satisfies scanner.Scanner. For each selected subscription it:
//  1. Builds an Azure credential from req.Credentials (auth_method routing)
//  2. Lists all Virtual Networks and their subnets (DDI Objects)
//  3. Lists all DNS zones and record sets, both public and private (DDI Objects)
//  4. Lists all VM NIC IPs (Active IPs — counted via NIC IPConfigurations)
//  5. Lists all Load Balancers and Application Gateways (Managed Assets)
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	cred, err := buildCredential(req.Credentials, req.CachedAzureCredential)
	if err != nil {
		return nil, fmt.Errorf("azure: build credential: %w", err)
	}

	subscriptions := req.Subscriptions
	if len(subscriptions) == 0 {
		return nil, errors.New("azure: no subscriptions selected")
	}

	return scanAllSubscriptions(ctx, cred, subscriptions, req.MaxWorkers, publish)
}

// scanAllSubscriptions fans out scanning across all subscriptions concurrently.
// Concurrency is limited by maxConcurrentSubscriptions (default 5), overridden
// by maxWorkers when non-zero. Per-subscription failures are non-fatal: an error
// event is published and remaining subscriptions continue.
func scanAllSubscriptions(ctx context.Context, cred azcore.TokenCredential, subscriptions []string, maxWorkers int, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	// Resolve subscription display names for human-readable Source fields.
	subNames := make(map[string]string, len(subscriptions))
	if subClient, err := armsubscriptions.NewClient(cred, nil); err == nil {
		for _, id := range subscriptions {
			if resp, err := subClient.Get(ctx, id, nil); err == nil && resp.DisplayName != nil {
				subNames[id] = *resp.DisplayName
			}
		}
	}

	// Determine concurrency limit.
	workers := maxConcurrentSubscriptions
	if maxWorkers > 0 {
		workers = maxWorkers
	}
	sem := cloudutil.NewSemaphore(workers)

	var (
		mu       sync.Mutex
		wg       sync.WaitGroup
		findings []calculator.FindingRow
	)

	for _, subID := range subscriptions {
		subID := subID // capture
		displayName := subNames[subID]
		if displayName == "" {
			displayName = subID // fallback to UUID if lookup failed
		}

		wg.Add(1)
		go func() {
			defer wg.Done()

			if err := sem.Acquire(ctx); err != nil {
				return
			}
			defer sem.Release()

			publish(scanner.Event{
				Type:     "subscription_progress",
				Provider: scanner.ProviderAzure,
				Status:   "scanning",
				Message:  fmt.Sprintf("scanning subscription %s (%s)", displayName, subID),
			})

			rows, scanErr := scanSubscriptionFunc(ctx, cred, subID, displayName, publish)

			mu.Lock()
			findings = append(findings, rows...)
			mu.Unlock()

			if scanErr != nil {
				publish(scanner.Event{
					Type:     "subscription_progress",
					Provider: scanner.ProviderAzure,
					Status:   "error",
					Message:  fmt.Sprintf("scan failed for subscription %s (%s): %v", displayName, subID, scanErr),
				})
			} else {
				publish(scanner.Event{
					Type:     "subscription_progress",
					Provider: scanner.ProviderAzure,
					Status:   "complete",
					Message:  fmt.Sprintf("completed subscription %s (%s): %d findings", displayName, subID, len(rows)),
				})
			}
		}()
	}

	wg.Wait()
	return findings, nil
}

// buildCredential creates an Azure TokenCredential from the credentials map.
// Supported auth_method values: "service-principal" (default), "browser-sso",
// "az-cli", "certificate", "device_code"/"device-code".
// When cached is non-nil and auth_method is interactive, the cached credential
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

	case "az-cli":
		if cached != nil {
			return cached, nil
		}
		// Fallback: create fresh CLI credential (should not happen in normal flow).
		return azidentity.NewAzureCLICredential(nil)

	case "certificate":
		if cached != nil {
			return cached, nil
		}
		// Fallback: should not happen — certificate credential is always cached during validation.
		return nil, errors.New("certificate credential not cached — re-validate")

	case "device_code", "device-code":
		if cached != nil {
			return cached, nil
		}
		// Fallback: should not happen — device code credential is always cached during validation.
		return nil, errors.New("device code credential not cached — re-validate")

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

// scanSubscriptionFunc is the function used by scanAllSubscriptions to scan
// a single subscription. It defaults to scanSubscription and can be swapped
// in tests to inject failures or stub results.
var scanSubscriptionFunc = scanSubscription

// scanSubscription discovers all Azure resources in a single subscription.
// Each resource type is isolated: on error, an error event is emitted and
// scanning continues to the next resource type (partial results are preserved).
func scanSubscription(ctx context.Context, cred azcore.TokenCredential, subID string, displayName string, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	var findings []calculator.FindingRow

	// ── VNets and subnets ─────────────────────────────────────────────────────
	vnetCount, subnetCount, vnetIDs, err := countVNetsAndSubnets(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "vnet",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "vnet",
			Count:    vnetCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
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
			Source:           displayName,
			Category:         calculator.CategoryDDIObjects,
			Item:             "subnet",
			Count:            subnetCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: subnetCount / calculator.TokensPerDDIObject,
		})
	}

	// ── DNS zones and records (public + private) ───────────────────────────────
	zoneCount, recordCount, err := countDNS(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "dns_zone",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "dns_zone",
			Count:    zoneCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
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
			Source:           displayName,
			Category:         calculator.CategoryDDIObjects,
			Item:             "dns_record",
			Count:            recordCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: recordCount / calculator.TokensPerDDIObject,
		})
	}

	// ── VM NIC IPs ────────────────────────────────────────────────────────────
	vmIPCount, err := countVMIPs(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "virtual_machine",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "virtual_machine",
			Count:    vmIPCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryActiveIPs,
			Item:             "virtual_machine",
			Count:            vmIPCount,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: vmIPCount / calculator.TokensPerActiveIP,
		})
	}

	// ── Load Balancers, Application Gateways, and LB Frontend IPs ───────────
	lbCount, gwCount, lbFrontendIPCount, err := countLBsAndGateways(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "load_balancer",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "load_balancer",
			Count:    lbCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
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
			Source:           displayName,
			Category:         calculator.CategoryManagedAssets,
			Item:             "application_gateway",
			Count:            gwCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: gwCount / calculator.TokensPerManagedAsset,
		})

		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "lb_frontend_ip",
			Count:    lbFrontendIPCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryActiveIPs,
			Item:             "lb_frontend_ip",
			Count:            lbFrontendIPCount,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: lbFrontendIPCount / calculator.TokensPerActiveIP,
		})
	}

	// ── Public IPs ───────────────────────────────────────────────────────────
	publicIPCount, err := countPublicIPs(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "public_ip",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "public_ip",
			Count:    publicIPCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryDDIObjects,
			Item:             "public_ip",
			Count:            publicIPCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: publicIPCount / calculator.TokensPerDDIObject,
		})
	}

	// ── NAT Gateways ─────────────────────────────────────────────────────────
	natGWCount, err := countNATGateways(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "nat_gateway",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "nat_gateway",
			Count:    natGWCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryManagedAssets,
			Item:             "nat_gateway",
			Count:            natGWCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: natGWCount / calculator.TokensPerManagedAsset,
		})
	}

	// ── Azure Firewalls ──────────────────────────────────────────────────────
	firewallCount, err := countAzureFirewalls(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "azure_firewall",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "azure_firewall",
			Count:    firewallCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryManagedAssets,
			Item:             "azure_firewall",
			Count:            firewallCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: firewallCount / calculator.TokensPerManagedAsset,
		})
	}

	// ── Private Endpoints ────────────────────────────────────────────────────
	privateEndpointCount, err := countPrivateEndpoints(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "private_endpoint",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "private_endpoint",
			Count:    privateEndpointCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryManagedAssets,
			Item:             "private_endpoint",
			Count:            privateEndpointCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: privateEndpointCount / calculator.TokensPerManagedAsset,
		})
	}

	// ── Route Tables ─────────────────────────────────────────────────────────
	routeTableCount, err := countRouteTables(ctx, cred, subID)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "route_table",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "route_table",
			Count:    routeTableCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryDDIObjects,
			Item:             "route_table",
			Count:            routeTableCount,
			TokensPerUnit:    calculator.TokensPerDDIObject,
			ManagementTokens: routeTableCount / calculator.TokensPerDDIObject,
		})
	}

	// ── VNet Gateways and Gateway IPs ────────────────────────────────────────
	vnetGWCount, vnetGWIPCount, err := countVNetGatewayIPs(ctx, cred, subID, vnetIDs)
	if err != nil {
		publish(scanner.Event{
			Type:     "error",
			Provider: scanner.ProviderAzure,
			Resource: "vnet_gateway",
			Status:   "error",
			Message:  err.Error(),
		})
	} else {
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "vnet_gateway",
			Count:    vnetGWCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryManagedAssets,
			Item:             "vnet_gateway",
			Count:            vnetGWCount,
			TokensPerUnit:    calculator.TokensPerManagedAsset,
			ManagementTokens: vnetGWCount / calculator.TokensPerManagedAsset,
		})

		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: scanner.ProviderAzure,
			Resource: "vnet_gateway_ip",
			Count:    vnetGWIPCount,
			Status:   "done",
		})
		findings = append(findings, calculator.FindingRow{
			Provider:         scanner.ProviderAzure,
			Source:           displayName,
			Category:         calculator.CategoryActiveIPs,
			Item:             "vnet_gateway_ip",
			Count:            vnetGWIPCount,
			TokensPerUnit:    calculator.TokensPerActiveIP,
			ManagementTokens: vnetGWIPCount / calculator.TokensPerActiveIP,
		})
	}

	return findings, nil
}

// countVNetsAndSubnets lists all Virtual Networks, counts their subnets, and
// collects VNet resource IDs (needed by countVNetGatewayIPs for RG extraction).
func countVNetsAndSubnets(ctx context.Context, cred azcore.TokenCredential, subID string) (vnets, subnets int, vnetIDs []string, err error) {
	client, err := armnetwork.NewVirtualNetworksClient(subID, cred, nil)
	if err != nil {
		return 0, 0, nil, err
	}

	pager := client.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return vnets, subnets, vnetIDs, err
		}
		for _, vnet := range page.Value {
			vnets++
			if vnet.ID != nil {
				vnetIDs = append(vnetIDs, *vnet.ID)
			}
			if vnet.Properties != nil && vnet.Properties.Subnets != nil {
				subnets += len(vnet.Properties.Subnets)
			}
		}
	}
	return vnets, subnets, vnetIDs, nil
}

// countDNS lists all public and private DNS zones and counts their record sets.
// Counts from both zone types are combined into the returned zones and records values.
func countDNS(ctx context.Context, cred azcore.TokenCredential, subID string) (zones, records int, err error) {
	// ── Public DNS zones (armdns) ─────────────────────────────────────────────
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

	// ── Private DNS zones (armprivatedns) ─────────────────────────────────────
	privateZonesClient, err := armprivatedns.NewPrivateZonesClient(subID, cred, nil)
	if err != nil {
		return zones, records, err
	}
	privateRecordsClient, err := armprivatedns.NewRecordSetsClient(subID, cred, nil)
	if err != nil {
		return zones, records, err
	}

	privateZonePager := privateZonesClient.NewListPager(nil)
	for privateZonePager.More() {
		page, err := privateZonePager.NextPage(ctx)
		if err != nil {
			return zones, records, err
		}
		for _, zone := range page.Value {
			zones++
			if zone.Name == nil || zone.ID == nil {
				continue
			}
			rgName := resourceGroupFromID(*zone.ID)
			if rgName == "" {
				continue
			}
			// Private DNS uses NewListPager (not NewListAllByDNSZonePager).
			rsPager := privateRecordsClient.NewListPager(rgName, *zone.Name, nil)
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

// countVMIPs counts the total number of IP configurations across all NICs
// that are attached to a Virtual Machine. Unattached NICs are skipped.
func countVMIPs(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	nicClient, err := armnetwork.NewInterfacesClient(subID, cred, nil)
	if err != nil {
		return 0, err
	}

	ipCount := 0
	pager := nicClient.NewListAllPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return ipCount, err
		}
		for _, nic := range page.Value {
			if nic.Properties == nil || nic.Properties.VirtualMachine == nil {
				continue
			}
			ipCount += len(nic.Properties.IPConfigurations)
		}
	}
	return ipCount, nil
}

// countLBsAndGateways lists all Load Balancers and Application Gateways.
// It also counts the total number of frontend IP configurations across all LBs.
func countLBsAndGateways(ctx context.Context, cred azcore.TokenCredential, subID string) (lbs, gateways, lbFrontendIPs int, err error) {
	lbClient, err := armnetwork.NewLoadBalancersClient(subID, cred, nil)
	if err != nil {
		return 0, 0, 0, err
	}
	gwClient, err := armnetwork.NewApplicationGatewaysClient(subID, cred, nil)
	if err != nil {
		return 0, 0, 0, err
	}

	lbPager := lbClient.NewListAllPager(nil)
	for lbPager.More() {
		page, err := lbPager.NextPage(ctx)
		if err != nil {
			return lbs, gateways, lbFrontendIPs, err
		}
		for _, lb := range page.Value {
			lbs++
			if lb.Properties != nil {
				lbFrontendIPs += len(lb.Properties.FrontendIPConfigurations)
			}
		}
	}

	gwPager := gwClient.NewListAllPager(nil)
	for gwPager.More() {
		page, err := gwPager.NextPage(ctx)
		if err != nil {
			return lbs, gateways, lbFrontendIPs, err
		}
		gateways += len(page.Value)
	}

	return lbs, gateways, lbFrontendIPs, nil
}

// countPublicIPs lists all public IP addresses in a subscription.
func countPublicIPs(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armnetwork.NewPublicIPAddressesClient(subID, cred, nil)
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

// countNATGateways lists all NAT gateways in a subscription.
func countNATGateways(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armnetwork.NewNatGatewaysClient(subID, cred, nil)
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

// countAzureFirewalls lists all Azure Firewalls in a subscription.
func countAzureFirewalls(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armnetwork.NewAzureFirewallsClient(subID, cred, nil)
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

// countPrivateEndpoints lists all private endpoints in a subscription.
func countPrivateEndpoints(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armnetwork.NewPrivateEndpointsClient(subID, cred, nil)
	if err != nil {
		return 0, err
	}

	count := 0
	pager := client.NewListBySubscriptionPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.Value)
	}
	return count, nil
}

// countRouteTables lists all route tables in a subscription.
func countRouteTables(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armnetwork.NewRouteTablesClient(subID, cred, nil)
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

// countVNetGatewayIPs iterates VNet gateways per resource group (using RG names
// extracted from VNet resource IDs) and counts both the gateway objects (Managed
// Assets) and their IP configurations (Active IPs). This avoids adding armresources
// as a dependency — VNet IDs are already available from countVNetsAndSubnets.
func countVNetGatewayIPs(ctx context.Context, cred azcore.TokenCredential, subID string, vnetResourceIDs []string) (gatewayCount, gatewayIPCount int, err error) {
	// Extract unique RG names from VNet resource IDs.
	seen := make(map[string]bool, len(vnetResourceIDs))
	var rgNames []string
	for _, id := range vnetResourceIDs {
		rg := resourceGroupFromID(id)
		if rg != "" && !seen[rg] {
			seen[rg] = true
			rgNames = append(rgNames, rg)
		}
	}

	if len(rgNames) == 0 {
		return 0, 0, nil
	}

	client, err := armnetwork.NewVirtualNetworkGatewaysClient(subID, cred, nil)
	if err != nil {
		return 0, 0, err
	}

	for _, rgName := range rgNames {
		pager := client.NewListPager(rgName, nil)
		for pager.More() {
			page, err := pager.NextPage(ctx)
			if err != nil {
				return gatewayCount, gatewayIPCount, err
			}
			for _, gw := range page.Value {
				gatewayCount++
				if gw.Properties != nil {
					gatewayIPCount += len(gw.Properties.IPConfigurations)
				}
			}
		}
	}
	return gatewayCount, gatewayIPCount, nil
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
