// Package graphclient provides helpers for querying Microsoft Graph API
// to fetch Entra ID (Azure AD) object counts for token calculation enrichment.
package graphclient

import (
	"context"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
)

// graphBaseURL is the Microsoft Graph API base URL.
// Tests override this with an httptest server URL.
var graphBaseURL = "https://graph.microsoft.com/v1.0"

// httpClient is the shared HTTP client with a 30-second timeout.
var httpClient = &http.Client{Timeout: 30 * time.Second}

// FetchEntraCounts queries the Microsoft Graph $count endpoints for users and
// devices. It returns (0, 0, nil) gracefully on any error — nil credential,
// token acquisition failure, HTTP errors, or parse failures — so that callers
// can always proceed without error handling.
func FetchEntraCounts(ctx context.Context, cred azcore.TokenCredential) (userCount, deviceCount int64, err error) {
	// Nil credential → skip silently.
	if cred == nil {
		return 0, 0, nil
	}

	// Acquire bearer token for Microsoft Graph.
	tokenResp, tokenErr := cred.GetToken(ctx, policy.TokenRequestOptions{
		Scopes: []string{"https://graph.microsoft.com/.default"},
	})
	if tokenErr != nil {
		log.Printf("[graphclient] warning: token acquisition failed: %v", tokenErr)
		return 0, 0, nil
	}

	token := tokenResp.Token

	userCount = fetchCount(ctx, token, graphBaseURL+"/users/$count")
	deviceCount = fetchCount(ctx, token, graphBaseURL+"/devices/$count")

	return userCount, deviceCount, nil
}

// fetchCount performs a GET request to the given Graph $count endpoint and
// parses the plain-text integer response body. Returns 0 on any error.
func fetchCount(ctx context.Context, token, endpoint string) int64 {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		log.Printf("[graphclient] warning: failed to create request for %s: %v", endpoint, err)
		return 0
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("ConsistencyLevel", "eventual")

	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("[graphclient] warning: request to %s failed: %v", endpoint, err)
		return 0
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[graphclient] warning: %s returned HTTP %d", endpoint, resp.StatusCode)
		return 0
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		log.Printf("[graphclient] warning: failed to read response from %s: %v", endpoint, err)
		return 0
	}

	count, err := strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	if err != nil {
		log.Printf("[graphclient] warning: failed to parse count from %s: %q: %v", endpoint, string(body), err)
		return 0
	}

	return count
}
