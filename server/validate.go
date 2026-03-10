package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sso"
	"github.com/aws/aws-sdk-go-v2/service/ssooidc"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	armsubscriptions "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armsubscriptions"
	"github.com/go-chi/chi/v5"
	"github.com/masterzen/winrm"
	pkgbrowser "github.com/pkg/browser"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	ad "github.com/infoblox/uddi-go-token-calculator/internal/scanner/ad"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// azureCredCache is an in-process store for live Azure token credentials obtained
// during browser-SSO validation. Keys are nanosecond timestamps stored in the
// credentials map as "azure_cred_cache_key" so storeCredentials can attach the
// live credential to the session for reuse by the scanner.
// Entries are never explicitly evicted — the process is single-user and short-lived.
var (
	azureCredCacheMu sync.Mutex
	azureCredCache   = make(map[string]azcore.TokenCredential)
)

// gcpTokenCache is an in-process store for live GCP OAuth2 token sources obtained
// during browser-oauth validation. Keys are nanosecond timestamps stored in the
// credentials map as "gcp_token_cache_key" so storeCredentials can attach the
// token source to the session for reuse by the scanner.
// Entries are never explicitly evicted — the process is single-user and short-lived.
var (
	gcpTokenCacheMu sync.Mutex
	gcpTokenCache   = make(map[string]oauth2.TokenSource)
)

// ValidateHandler handles POST /api/v1/providers/{provider}/validate.
// Validators are injectable for testability — real implementations call cloud APIs,
// test doubles return hardcoded results without network calls.
type ValidateHandler struct {
	store          *session.Store
	AWSValidator   func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	AzureValidator func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	GCPValidator   func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	ADValidator    func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
}

// NewValidateHandler constructs a ValidateHandler wired with real cloud validators.
func NewValidateHandler(store *session.Store) *ValidateHandler {
	return &ValidateHandler{
		store:          store,
		AWSValidator:   realAWSValidator,
		AzureValidator: realAzureValidator,
		GCPValidator:   realGCPValidator,
		ADValidator:    realADValidator,
	}
}

// RegisterValidateHandler mounts the validate route onto an existing chi router.
// Called from NewRouter (and from tests via server.RegisterValidateHandler).
func RegisterValidateHandler(r *chi.Mux, h *ValidateHandler) {
	r.Post("/api/v1/providers/{provider}/validate", h.HandleValidate)
}

// HandleValidate handles POST /api/v1/providers/{provider}/validate.
//
// On success:
//   - Runs the provider-specific validator (real API call or stub)
//   - Creates a session via store.New() and stores credentials
//   - Sets an httpOnly "ddi_session" cookie
//   - Returns 200 with {valid:true, subscriptions:[...]}
//
// On failure:
//   - Returns 200 with {valid:false, error:"..."} — no session is created
//
// On unknown provider or malformed body:
//   - Returns 400
//
// SECURITY: credentials are written once into the session store and are never
// included in any response body or log statement.
func (h *ValidateHandler) HandleValidate(w http.ResponseWriter, r *http.Request) {
	provider := chi.URLParam(r, "provider")

	var req ValidateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}

	var validator func(context.Context, map[string]string) ([]SubscriptionItem, error)
	switch provider {
	case "aws":
		validator = h.AWSValidator
	case "azure":
		validator = h.AzureValidator
	case "gcp":
		validator = h.GCPValidator
	case "ad":
		validator = h.ADValidator
	default:
		writeJSON(w, http.StatusBadRequest, ValidateResponse{
			Valid:         false,
			Error:         "unknown provider: " + provider,
			Subscriptions: []SubscriptionItem{},
		})
		return
	}

	// Merge authMethod into the credentials map so validators can route on it.
	// The credentials map is local to this request — merging does not affect
	// the caller's original map.
	merged := make(map[string]string, len(req.Credentials)+1)
	for k, v := range req.Credentials {
		merged[k] = v
	}
	merged["authMethod"] = req.AuthMethod

	subs, err := validator(r.Context(), merged)
	if err != nil {
		writeJSON(w, http.StatusOK, ValidateResponse{
			Valid:         false,
			Error:         err.Error(),
			Subscriptions: []SubscriptionItem{},
		})
		return
	}

	// Validation succeeded — create session and store credentials.
	// Pass merged (not req.Credentials) so that any tokens written back by the
	// validator (e.g. sso_access_token written by realAWSSSO) are captured.
	sess := h.store.New()
	storeCredentials(sess, provider, req.AuthMethod, merged)

	http.SetCookie(w, &http.Cookie{
		Name:     "ddi_session",
		Value:    sess.ID,
		HttpOnly: true,
		Secure:   false, // localhost — HTTPS not applicable
		SameSite: http.SameSiteStrictMode,
		Path:     "/",
		MaxAge:   3600,
	})

	if subs == nil {
		subs = []SubscriptionItem{}
	}
	writeJSON(w, http.StatusOK, ValidateResponse{
		Valid:         true,
		Subscriptions: subs,
	})
}

// storeCredentials writes the validated credentials into the session.
// Credentials are write-once — they must never be read back out of the session
// into any HTTP response body.
func storeCredentials(sess *session.Session, provider, authMethod string, creds map[string]string) {
	switch provider {
	case "aws":
		// Frontend sends "profile", backend historically read "profileName".
		// Accept both keys so the session is populated regardless of which is sent.
		profileName := creds["profileName"]
		if profileName == "" {
			profileName = creds["profile"]
		}
		sess.AWS = &session.AWSCredentials{
			AuthMethod:      authMethod,
			AccessKeyID:     creds["accessKeyId"],
			SecretAccessKey: creds["secretAccessKey"],
			SessionToken:    creds["sessionToken"],
			Region:          creds["region"],
			ProfileName:     profileName,
			RoleARN:         creds["roleArn"],
			SSOStartURL:     creds["ssoStartUrl"],
			SSORegion:       creds["ssoRegion"],
			// sso_access_token is written back into merged by realAWSSSO so it is
			// available here. For non-SSO auth methods this will be an empty string.
			SSOAccessToken:  creds["sso_access_token"],
		}
	case "azure":
		var cachedCred azcore.TokenCredential
		if cacheKey := creds["azure_cred_cache_key"]; cacheKey != "" {
			azureCredCacheMu.Lock()
			cachedCred = azureCredCache[cacheKey]
			azureCredCacheMu.Unlock()
		}
		sess.Azure = &session.AzureCredentials{
			AuthMethod:       authMethod,
			TenantID:         creds["tenantId"],
			ClientID:         creds["clientId"],
			ClientSecret:     creds["clientSecret"],
			CachedCredential: cachedCred,
		}
	case "gcp":
		var cachedTS oauth2.TokenSource
		if cacheKey := creds["gcp_token_cache_key"]; cacheKey != "" {
			gcpTokenCacheMu.Lock()
			cachedTS = gcpTokenCache[cacheKey]
			gcpTokenCacheMu.Unlock()
		}
		sess.GCP = &session.GCPCredentials{
			AuthMethod:         authMethod,
			ServiceAccountJSON: creds["serviceAccountJson"],
			CachedTokenSource:  cachedTS,
		}
	case "ad":
		// Frontend sends "server" (singular), backend historically read "servers" (plural).
		// Accept both keys so the session is populated regardless of which is sent,
		// matching the same fallback logic already in realADValidator.
		hosts := parseServers(creds["servers"])
		if len(hosts) == 0 {
			if h := creds["server"]; h != "" {
				hosts = []string{h}
			}
		}
		sess.AD = &session.ADCredentials{
			AuthMethod: authMethod,
			Hosts:      hosts,
			Username:   creds["username"],
			Password:   creds["password"],
			Domain:     creds["domain"],
		}
	}
}

// realAWSSSO implements the AWS IAM Identity Center (SSO) OIDC device authorization flow.
// It registers an OIDC client, starts device authorization, opens the system browser for
// the user to approve, then polls until a token is received or the 120-second timeout fires.
// On success it lists all accessible AWS accounts via the SSO service.
// The access token is stored in creds["sso_access_token"] so that HandleValidate can persist
// it to the session for later use by the scanner.
func realAWSSSO(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	startURL := creds["ssoStartUrl"]
	ssoRegion := creds["ssoRegion"]
	if startURL == "" || ssoRegion == "" {
		return nil, errors.New("ssoStartUrl and ssoRegion are required for SSO authentication")
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(ssoRegion),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	oidcClient := ssooidc.NewFromConfig(cfg)

	// Register a public OIDC client — no secret needed for device authorization flow.
	regResp, err := oidcClient.RegisterClient(ctx, &ssooidc.RegisterClientInput{
		ClientName: strPtr("ddi-scanner"),
		ClientType: strPtr("public"),
	})
	if err != nil {
		return nil, fmt.Errorf("OIDC RegisterClient failed: %w", err)
	}

	// Start device authorization — returns a verification URI and user code.
	authResp, err := oidcClient.StartDeviceAuthorization(ctx, &ssooidc.StartDeviceAuthorizationInput{
		ClientId:     regResp.ClientId,
		ClientSecret: regResp.ClientSecret,
		StartUrl:     &startURL,
	})
	if err != nil {
		return nil, fmt.Errorf("OIDC StartDeviceAuthorization failed: %w", err)
	}

	// Open the verification URL in the system browser.
	openURL := ""
	if authResp.VerificationUriComplete != nil && *authResp.VerificationUriComplete != "" {
		openURL = *authResp.VerificationUriComplete
	} else if authResp.VerificationUri != nil {
		openURL = *authResp.VerificationUri
	}
	if openURL != "" {
		_ = pkgbrowser.OpenURL(openURL)
	}

	// Determine polling interval; AWS recommends 5 seconds minimum.
	pollInterval := 5 * time.Second
	if authResp.Interval != 0 {
		pollInterval = time.Duration(authResp.Interval) * time.Second
	}

	deadline := time.Now().Add(120 * time.Second)

	var accessToken string
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return nil, errors.New("SSO login cancelled")
		case <-time.After(pollInterval):
		}

		tokenResp, err := oidcClient.CreateToken(ctx, &ssooidc.CreateTokenInput{
			ClientId:     regResp.ClientId,
			ClientSecret: regResp.ClientSecret,
			DeviceCode:   authResp.DeviceCode,
			GrantType:    strPtr("urn:ietf:params:oauth:grant-type:device_code"),
		})
		if err != nil {
			errStr := err.Error()
			// These are expected transient errors during polling.
			if contains(errStr, "AuthorizationPendingException") || contains(errStr, "authorization_pending") {
				continue
			}
			if contains(errStr, "SlowDownException") || contains(errStr, "slow_down") {
				pollInterval *= 2
				continue
			}
			return nil, fmt.Errorf("SSO login failed: %w", err)
		}

		if tokenResp.AccessToken != nil {
			accessToken = *tokenResp.AccessToken
			break
		}
	}

	if accessToken == "" {
		return nil, errors.New("SSO login timed out — please try again and approve within 2 minutes")
	}

	// Persist the access token back into the caller's creds map.
	// HandleValidate passes the mutable merged map, so storeCredentials can read
	// sso_access_token when it creates the session, enabling the scanner to call
	// sso:GetRoleCredentials without re-running the browser flow.
	creds["sso_access_token"] = accessToken

	// Use the access token to list accessible AWS accounts.
	ssoClient := sso.NewFromConfig(cfg)
	var items []SubscriptionItem
	paginator := sso.NewListAccountsPaginator(ssoClient, &sso.ListAccountsInput{
		AccessToken: &accessToken,
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list SSO accounts: %w", err)
		}
		for _, acc := range page.AccountList {
			id := ""
			name := ""
			if acc.AccountId != nil {
				id = *acc.AccountId
			}
			if acc.AccountName != nil {
				name = *acc.AccountName
			}
			items = append(items, SubscriptionItem{ID: id, Name: name})
		}
	}

	if len(items) == 0 {
		return nil, errors.New("no AWS accounts accessible via this SSO session")
	}

	return items, nil
}

// strPtr returns a pointer to the given string value.
func strPtr(s string) *string { return &s }

// contains reports whether substr is present in s (case-insensitive not needed here).
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}

// realAWSValidator calls sts:GetCallerIdentity with the supplied static credentials.
// SSO is handled by realAWSSSO; profile and assume-role return a coming-soon message.
func realAWSValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	switch creds["authMethod"] {
	case "sso":
		return realAWSSSO(ctx, creds)
	case "profile", "assume_role", "assume-role":
		return nil, errors.New("Coming soon — not yet implemented in this version")
	}

	accessKeyID := creds["accessKeyId"]
	secretAccessKey := creds["secretAccessKey"]
	if accessKeyID == "" || secretAccessKey == "" {
		return nil, errors.New("accessKeyId and secretAccessKey are required")
	}

	region := creds["region"]
	if region == "" {
		region = "us-east-1" // STS is a global service; any region works for GetCallerIdentity
	}

	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, creds["sessionToken"]),
		),
		awsconfig.WithRegion(region),
	)
	if err != nil {
		return nil, err
	}

	client := sts.NewFromConfig(cfg)
	identity, err := client.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return nil, err
	}

	account := ""
	if identity.Account != nil {
		account = *identity.Account
	}
	return []SubscriptionItem{{
		ID:   account,
		Name: "AWS Account " + account,
	}}, nil
}

// realAzureBrowserSSO implements interactive browser login via azidentity.InteractiveBrowserCredential.
// It uses the well-known Azure CLI public client ID so users do not need their own app registration.
// The SDK opens a localhost redirect listener and launches the system browser automatically.
func realAzureBrowserSSO(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	tenantID := creds["tenantId"]
	if tenantID == "" {
		return nil, errors.New("tenantId is required for browser SSO authentication")
	}

	// Use the Azure CLI well-known public client ID — no client secret required.
	const azureCLIClientID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"

	cred, err := azidentity.NewInteractiveBrowserCredential(&azidentity.InteractiveBrowserCredentialOptions{
		TenantID: tenantID,
		ClientID: azureCLIClientID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create browser credential: %w", err)
	}

	// GetToken triggers the browser open and blocks until login completes or ctx is cancelled.
	_, err = cred.GetToken(ctx, policy.TokenRequestOptions{
		Scopes: []string{"https://management.azure.com/.default"},
	})
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New("browser SSO login cancelled or timed out")
		}
		return nil, fmt.Errorf("browser SSO login failed: %w", err)
	}

	// Cache the live credential so the scanner can reuse it without triggering
	// a second browser popup. The cache key is written into creds so storeCredentials
	// can retrieve the credential and attach it to the session.
	cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
	azureCredCacheMu.Lock()
	azureCredCache[cacheKey] = cred
	azureCredCacheMu.Unlock()
	creds["azure_cred_cache_key"] = cacheKey

	// List subscriptions accessible with this credential.
	client, err := armsubscriptions.NewClient(cred, nil)
	if err != nil {
		return nil, err
	}

	var items []SubscriptionItem
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, sub := range page.Value {
			id := ""
			name := ""
			if sub.SubscriptionID != nil {
				id = *sub.SubscriptionID
			}
			if sub.DisplayName != nil {
				name = *sub.DisplayName
			}
			items = append(items, SubscriptionItem{ID: id, Name: name})
		}
	}

	if len(items) == 0 {
		return nil, errors.New("no Azure subscriptions found for this account — ensure the account has Reader role on at least one subscription")
	}

	return items, nil
}

// realAzureValidator lists subscriptions using ClientSecretCredential.
// DefaultAzureCredential is explicitly prohibited — it may pick up ambient credentials
// from the developer machine and bypass the user-supplied credentials entirely.
func realAzureValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	switch creds["authMethod"] {
	case "browser-sso":
		return realAzureBrowserSSO(ctx, creds)
	case "device_code", "device-code":
		return nil, errors.New("Coming soon — not yet implemented in this version")
	}

	tenantID := creds["tenantId"]
	clientID := creds["clientId"]
	clientSecret := creds["clientSecret"]
	if tenantID == "" || clientID == "" || clientSecret == "" {
		return nil, errors.New("tenantId, clientId, and clientSecret are required")
	}

	cred, err := azidentity.NewClientSecretCredential(tenantID, clientID, clientSecret, nil)
	if err != nil {
		return nil, err
	}

	client, err := armsubscriptions.NewClient(cred, nil)
	if err != nil {
		return nil, err
	}

	var items []SubscriptionItem
	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, sub := range page.Value {
			id := ""
			name := ""
			if sub.SubscriptionID != nil {
				id = *sub.SubscriptionID
			}
			if sub.DisplayName != nil {
				name = *sub.DisplayName
			}
			items = append(items, SubscriptionItem{ID: id, Name: name})
		}
	}

	if len(items) == 0 {
		return nil, errors.New("no Azure subscriptions found — ensure the service principal has Reader role on at least one subscription")
	}

	return items, nil
}

// realGCPValidator validates GCP credentials and returns a project list.
// Supports two auth methods:
//   - "adc": Application Default Credentials (gcloud auth application-default login)
//   - "service-account" (default): parse service account JSON, return project_id
func realGCPValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	if creds["authMethod"] == "adc" {
		return realGCPADCValidator(ctx, creds)
	}

	saJSON := creds["serviceAccountJson"]
	if saJSON == "" {
		return nil, errors.New("serviceAccountJson is required")
	}

	// Structural validation: parse the JSON and extract project_id.
	// Deep credential verification happens when the scan actually calls GCP APIs.
	var saFields struct {
		Type      string `json:"type"`
		ProjectID string `json:"project_id"`
	}
	if err := json.Unmarshal([]byte(saJSON), &saFields); err != nil {
		return nil, fmt.Errorf("gcp: invalid service account JSON: %w", err)
	}
	if saFields.ProjectID == "" {
		return nil, errors.New("gcp: service account JSON must contain a non-empty project_id field")
	}
	if saFields.Type != "service_account" {
		return nil, fmt.Errorf("gcp: expected type \"service_account\", got %q", saFields.Type)
	}

	return []SubscriptionItem{{
		ID:   saFields.ProjectID,
		Name: saFields.ProjectID,
	}}, nil
}

// realGCPADCValidator validates using Application Default Credentials (ADC).
// ADC is populated by running: gcloud auth application-default login
// It discovers accessible projects via the Cloud Resource Manager API.
func realGCPADCValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	googleCreds, err := google.FindDefaultCredentials(ctx,
		"https://www.googleapis.com/auth/compute.readonly",
		"https://www.googleapis.com/auth/ndev.clouddns.readonly",
		"https://www.googleapis.com/auth/cloudplatformprojects.readonly",
	)
	if err != nil {
		return nil, fmt.Errorf("gcp adc: no application default credentials found — run: gcloud auth application-default login\n(%w)", err)
	}

	ts := googleCreds.TokenSource

	// List accessible projects via Cloud Resource Manager REST API.
	httpClient := oauth2.NewClient(ctx, ts)
	resp, err := httpClient.Get("https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE")
	if err != nil {
		return nil, fmt.Errorf("gcp adc: list projects: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gcp adc: list projects returned HTTP %d", resp.StatusCode)
	}

	var result struct {
		Projects []struct {
			ProjectID string `json:"projectId"`
			Name      string `json:"name"`
		} `json:"projects"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("gcp adc: decode projects: %w", err)
	}

	if len(result.Projects) == 0 {
		return nil, errors.New("gcp adc: no accessible GCP projects found for this account")
	}

	// Cache the token source so storeCredentials can attach it to the session.
	cacheKey := fmt.Sprintf("gcpts-%d", time.Now().UnixNano())
	gcpTokenCacheMu.Lock()
	gcpTokenCache[cacheKey] = ts
	gcpTokenCacheMu.Unlock()
	creds["gcp_token_cache_key"] = cacheKey

	items := make([]SubscriptionItem, 0, len(result.Projects))
	for _, p := range result.Projects {
		name := p.Name
		if name == "" {
			name = p.ProjectID
		}
		items = append(items, SubscriptionItem{ID: p.ProjectID, Name: name})
	}
	return items, nil
}

// realADValidator validates Active Directory / WinRM credentials by opening a
// WinRM connection and running a lightweight PowerShell probe ($PSVersionTable).
// NTLM is the only supported auth method — Kerberos requires a domain-joined machine.
// The frontend sends a comma-separated "servers" field; the validator probes the first
// server and returns one SubscriptionItem per server on success.
func realADValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	// Parse the first server from the comma-separated list for the connectivity probe.
	servers := parseServers(creds["servers"])
	if len(servers) == 0 {
		// Fall back to legacy "server" / "host" keys for any direct API callers.
		if h := creds["server"]; h != "" {
			servers = []string{h}
		} else if h := creds["host"]; h != "" {
			servers = []string{h}
		}
	}
	host := ""
	if len(servers) > 0 {
		host = servers[0]
	}
	username := creds["username"]
	password := creds["password"]
	if host == "" || username == "" || password == "" {
		return nil, errors.New("server address, username, and password are required")
	}

	// Build a WinRM client with NTLM + message-level encryption via the shared
	// BuildNTLMClient helper in the ad package — single source of truth for NTLM
	// client construction. Windows DCs reject unencrypted sessions; BuildNTLMClient
	// uses bodgit/ntlmssp to produce the SPNEGO multipart/encrypted framing DCs require.
	client, err := ad.BuildNTLMClient(host, username, password)
	if err != nil {
		return nil, fmt.Errorf("WinRM client error: %w", err)
	}

	// Wrap the connectivity probe in a hard 10s deadline so an unreachable host
	// fails fast instead of blocking the wizard for the full scan timeout.
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var outBuf, errBuf strings.Builder
	exitCode, err := client.RunWithContext(probeCtx,
		winrm.Powershell(`$PSVersionTable.PSVersion.Major`),
		&outBuf, &errBuf,
	)
	if err != nil {
		return nil, fmt.Errorf("WinRM connection failed: %w", err)
	}
	if exitCode != 0 {
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = strings.TrimSpace(outBuf.String())
		}
		return nil, fmt.Errorf("WinRM probe failed (exit %d): %s", exitCode, msg)
	}

	// Resolve COMPUTERNAME for each DC concurrently (best-effort, 10s timeout per server).
	// On success: name = "DC01 (192.168.1.10)". On failure: fall back to raw host.
	const maxConcurrentResolutions = 5
	sem := make(chan struct{}, maxConcurrentResolutions)
	names := make([]string, len(servers))
	var wg sync.WaitGroup
	for i, s := range servers {
		wg.Add(1)
		go func(idx int, host string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			c, cerr := ad.BuildNTLMClient(host, username, password)
			if cerr != nil {
				names[idx] = host
				return
			}
			resolveCtx, resolveCancel := context.WithTimeout(ctx, 10*time.Second)
			defer resolveCancel()
			var nameOut, nameErr strings.Builder
			exitCode2, rerr := c.RunWithContext(resolveCtx,
				winrm.Powershell(`$env:COMPUTERNAME`),
				&nameOut, &nameErr,
			)
			if rerr != nil || exitCode2 != 0 {
				names[idx] = host
				return
			}
			cn := strings.TrimSpace(nameOut.String())
			if cn == "" {
				names[idx] = host
				return
			}
			names[idx] = cn + " (" + host + ")"
		}(i, s)
	}
	wg.Wait()

	items := make([]SubscriptionItem, 0, len(servers))
	for i, s := range servers {
		items = append(items, SubscriptionItem{ID: s, Name: names[i]})
	}
	return items, nil
}

// parseServers splits a comma-separated string of server hostnames into a []string,
// trimming whitespace and discarding empty entries.
func parseServers(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		if h = strings.TrimSpace(h); h != "" {
			out = append(out, h)
		}
	}
	return out
}
