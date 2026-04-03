package azure

import (
	"context"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	armnetwork "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v6"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
)

// listResourceGroups returns all resource group names in the subscription.
func listResourceGroups(ctx context.Context, cred azcore.TokenCredential, subID string) ([]string, error) {
	client, err := armresources.NewResourceGroupsClient(subID, cred, nil)
	if err != nil {
		return nil, err
	}

	var names []string
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return names, err
		}
		for _, rg := range page.Value {
			if rg.Name != nil {
				names = append(names, *rg.Name)
			}
		}
	}
	return names, nil
}

// countVPNGateways lists all Virtual Network Gateways (VPN/ExpressRoute gateways) in the subscription.
// These are counted as Managed Assets per the Engineering token spreadsheet.
// VirtualNetworkGatewaysClient has no subscription-level ListAll, so we iterate resource groups.
func countVPNGateways(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	rgNames, err := listResourceGroups(ctx, cred, subID)
	if err != nil {
		return 0, err
	}

	gwClient, err := armnetwork.NewVirtualNetworkGatewaysClient(subID, cred, nil)
	if err != nil {
		return 0, err
	}

	count := 0
	for _, rg := range rgNames {
		pager := gwClient.NewListPager(rg, nil)
		for pager.More() {
			page, err := pager.NextPage(ctx)
			if err != nil {
				break // skip this RG on error, continue with others
			}
			count += len(page.Value)
		}
	}
	return count, nil
}

// countAzureFirewalls lists all Azure Firewalls in the subscription.
// These are counted as Managed Assets per the Engineering token spreadsheet.
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

// countVirtualHubs lists all Virtual Hubs (Azure Virtual WAN hubs) in the subscription.
// These are counted as Managed Assets per the Engineering token spreadsheet.
func countVirtualHubs(ctx context.Context, cred azcore.TokenCredential, subID string) (int, error) {
	client, err := armnetwork.NewVirtualHubsClient(subID, cred, nil)
	if err != nil {
		return 0, err
	}

	count := 0
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return count, err
		}
		count += len(page.Value)
	}
	return count, nil
}
