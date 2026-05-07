package azure

import (
	"context"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	armnetwork "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/network/armnetwork/v6"
)

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
