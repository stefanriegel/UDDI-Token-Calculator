package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sso"
	"github.com/aws/aws-sdk-go-v2/service/ssooidc"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
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
	store               *session.Store
	AWSValidator        func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	AzureValidator      func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	GCPValidator        func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	ADValidator         func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	BluecatValidator    func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	EfficientIPValidator func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
	NiosWAPIValidator   func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
}

// NewValidateHandler constructs a ValidateHandler wired with real cloud validators.
func NewValidateHandler(store *session.Store) *ValidateHandler {
	return &ValidateHandler{
		store:               store,
		AWSValidator:        realAWSValidator,
		AzureValidator:      realAzureValidator,
		GCPValidator:        realGCPValidator,
		ADValidator:         realADValidator,
		BluecatValidator:    realBluecatValidator,
		EfficientIPValidator: realEfficientIPValidator,
		NiosWAPIValidator:   realNiosWAPIValidator,
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
	case "bluecat":
		validator = h.BluecatValidator
	case "efficientip":
		validator = h.EfficientIPValidator
	case "nios":
		// NIOS supports two modes: "backup" (file upload) and "wapi" (live WAPI).
		// The backup mode is handled by HandleUploadNiosBackup, not the validate handler.
		// Only route to the WAPI validator when authMethod is "wapi".
		if req.AuthMethod == "wapi" {
			validator = h.NiosWAPIValidator
		} else {
			writeJSON(w, http.StatusOK, ValidateResponse{
				Valid:         false,
				Error:         "NIOS backup mode uses the upload endpoint, not validate",
				Subscriptions: []SubscriptionItem{},
			})
			return
		}
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

	// Validation succeeded — reuse existing session if one exists (multi-provider),
	// otherwise create a new one. This ensures credentials from previously-validated
	// providers are preserved when the user validates multiple providers sequentially.
	// Pass merged (not req.Credentials) so that any tokens written back by the
	// validator (e.g. sso_access_token written by realAWSSSO) are captured.
	var sess *session.Session
	if cookie, err := r.Cookie("ddi_session"); err == nil {
		if existing, ok := h.store.Get(cookie.Value); ok && existing.State == session.ScanStateCreated {
			sess = existing
		}
	}
	if sess == nil {
		sess = h.store.New()
		http.SetCookie(w, &http.Cookie{
			Name:     "ddi_session",
			Value:    sess.ID,
			HttpOnly: true,
			Secure:   false, // localhost — HTTPS not applicable
			SameSite: http.SameSiteStrictMode,
			Path:     "/",
			MaxAge:   3600,
		})
	}
	storeCredentials(sess, provider, req.AuthMethod, merged)

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
			SSORegion:       defaultIfEmpty(creds["ssoRegion"], "us-east-1"),
			// sso_access_token is written back into merged by realAWSSSO so it is
			// available here. For non-SSO auth methods this will be an empty string.
			SSOAccessToken:  creds["sso_access_token"],
			SourceProfile:   creds["sourceProfile"],
			ExternalID:      creds["externalId"],
		}
	case "azure":
		var cachedCred azcore.TokenCredential
		if cacheKey := creds["azure_cred_cache_key"]; cacheKey != "" {
			azureCredCacheMu.Lock()
			cachedCred = azureCredCache[cacheKey]
			azureCredCacheMu.Unlock()
		}
		sess.Azure = &session.AzureCredentials{
			AuthMethod:          authMethod,
			TenantID:            creds["tenantId"],
			ClientID:            creds["clientId"],
			ClientSecret:        creds["clientSecret"],
			CertificateData:     creds["certificateData"],
			CertificatePassword: creds["certificatePassword"],
			CachedCredential:    cachedCred,
		}
	case "gcp":
		var cachedTS oauth2.TokenSource
		if cacheKey := creds["gcp_token_cache_key"]; cacheKey != "" {
			gcpTokenCacheMu.Lock()
			cachedTS = gcpTokenCache[cacheKey]
			gcpTokenCacheMu.Unlock()
		}
		sess.GCP = &session.GCPCredentials{
			AuthMethod:           authMethod,
			ServiceAccountJSON:   creds["serviceAccountJson"],
			WorkloadIdentityJSON: creds["workloadIdentityJson"],
			ProjectID:            creds["projectId"],
			CachedTokenSource:    cachedTS,
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
			AuthMethod:         authMethod,
			Hosts:              hosts,
			Username:           creds["username"],
			Password:           creds["password"],
			Domain:             creds["domain"],
			UseSSL:             creds["useSSL"] == "true",
			InsecureSkipVerify: creds["insecureSkipVerify"] == "true",
			Realm:              creds["realm"],
			KDC:                creds["kdc"],
		}
	case "bluecat":
		var configIDs []string
		if raw := creds["configuration_ids"]; raw != "" {
			for _, id := range strings.Split(raw, ",") {
				if id = strings.TrimSpace(id); id != "" {
					configIDs = append(configIDs, id)
				}
			}
		}
		sess.Bluecat = &session.BluecatCredentials{
			URL:              creds["bluecat_url"],
			Username:         creds["bluecat_username"],
			Password:         creds["bluecat_password"],
			SkipTLS:          creds["skip_tls"] == "true",
			ConfigurationIDs: configIDs,
		}
	case "efficientip":
		var siteIDs []string
		if raw := creds["site_ids"]; raw != "" {
			for _, id := range strings.Split(raw, ",") {
				if id = strings.TrimSpace(id); id != "" {
					siteIDs = append(siteIDs, id)
				}
			}
		}
		sess.EfficientIP = &session.EfficientIPCredentials{
			URL:      creds["efficientip_url"],
			Username: creds["efficientip_username"],
			Password: creds["efficientip_password"],
			SkipTLS:  creds["skip_tls"] == "true",
			SiteIDs:  siteIDs,
		}
	case "nios":
		// Only store WAPI credentials when authMethod is "wapi".
		// Backup mode credentials are handled by HandleUploadNiosBackup.
		if authMethod == "wapi" {
			sess.NiosWAPI = &session.NiosWAPICredentials{
				URL:             creds["wapi_url"],
				Username:        creds["wapi_username"],
				Password:        creds["wapi_password"],
				SkipTLS:         creds["skip_tls"] == "true",
				ExplicitVersion: creds["wapi_version"],
			}
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
	if startURL == "" {
		return nil, errors.New("ssoStartUrl is required for SSO authentication")
	}
	if ssoRegion == "" {
		ssoRegion = "us-east-1"
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

// defaultIfEmpty returns val if non-empty, otherwise fallback.
func defaultIfEmpty(val, fallback string) string {
	if val == "" {
		return fallback
	}
	return val
}

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
	case "profile":
		profileName := creds["profile"]
		if profileName == "" {
			profileName = "default"
		}
		cfg, err := awsconfig.LoadDefaultConfig(ctx,
			awsconfig.WithSharedConfigProfile(profileName),
		)
		if err != nil {
			return nil, fmt.Errorf("AWS CLI profile %q: %w", profileName, err)
		}
		stsClient := sts.NewFromConfig(cfg)
		identity, err := stsClient.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
		if err != nil {
			return nil, fmt.Errorf("AWS profile %q authentication failed: %w", profileName, err)
		}
		accountID := aws.ToString(identity.Account)
		return []SubscriptionItem{{ID: accountID, Name: "Account " + accountID}}, nil

	case "assume_role", "assume-role":
		sourceProfile := creds["sourceProfile"]
		if sourceProfile == "" {
			sourceProfile = "default"
		}
		roleArn := creds["roleArn"]
		if roleArn == "" {
			return nil, errors.New("Role ARN is required for assume-role authentication")
		}
		baseCfg, err := awsconfig.LoadDefaultConfig(ctx,
			awsconfig.WithSharedConfigProfile(sourceProfile),
		)
		if err != nil {
			return nil, fmt.Errorf("source profile %q: %w", sourceProfile, err)
		}
		stsClient := sts.NewFromConfig(baseCfg)
		input := &sts.AssumeRoleInput{
			RoleArn:         aws.String(roleArn),
			RoleSessionName: aws.String("uddi-validate"),
		}
		if eid := creds["externalId"]; eid != "" {
			input.ExternalId = aws.String(eid)
		}
		result, err := stsClient.AssumeRole(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("assume role %s: %w", roleArn, err)
		}
		// Use GetCallerIdentity with assumed credentials for clean account ID.
		assumedCfg, _ := awsconfig.LoadDefaultConfig(ctx,
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				aws.ToString(result.Credentials.AccessKeyId),
				aws.ToString(result.Credentials.SecretAccessKey),
				aws.ToString(result.Credentials.SessionToken),
			)),
		)
		assumedSTS := sts.NewFromConfig(assumedCfg)
		identity, idErr := assumedSTS.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
		targetAccountID := ""
		if idErr == nil {
			targetAccountID = aws.ToString(identity.Account)
		} else {
			// Fallback: parse account ID from assumed role ARN
			targetAccountID = parseAccountFromARN(aws.ToString(result.AssumedRoleUser.Arn))
		}
		return []SubscriptionItem{{ID: targetAccountID, Name: "Account " + targetAccountID + " (assumed role)"}}, nil
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

// parseAccountFromARN extracts the AWS account ID (field [4]) from an ARN string.
// ARN format: arn:aws:sts::ACCOUNT_ID:assumed-role/...
// Returns "unknown" if parsing fails.
func parseAccountFromARN(arn string) string {
	parts := strings.Split(arn, ":")
	if len(parts) >= 5 && parts[4] != "" {
		return parts[4]
	}
	return "unknown"
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

	// Cache the live credential so the scanner can reuse it without triggering
	// a second browser popup. The cache key is written into creds so storeCredentials
	// can retrieve the credential and attach it to the session.
	cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
	azureCredCacheMu.Lock()
	azureCredCache[cacheKey] = cred
	azureCredCacheMu.Unlock()
	creds["azure_cred_cache_key"] = cacheKey

	// List subscriptions accessible with this credential.
	return listAzureSubscriptions(ctx, cred)
}

// listAzureSubscriptions lists all subscriptions accessible with the given credential.
// Shared helper used by realAzureBrowserSSO, realAzureCLI, and realAzureValidator.
func listAzureSubscriptions(ctx context.Context, cred azcore.TokenCredential) ([]SubscriptionItem, error) {
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

// realAzureCLI implements Azure CLI authentication using the existing `az login` session.
// Pre-checks that the az binary exists before attempting credential creation.
func realAzureCLI(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	// Pre-check az binary existence.
	if _, err := exec.LookPath("az"); err != nil {
		return nil, errors.New("Azure CLI (az) not found — install from https://aka.ms/installazurecli")
	}

	cred, err := azidentity.NewAzureCLICredential(nil)
	if err != nil {
		return nil, fmt.Errorf("Azure CLI credential failed — run 'az login' in a terminal first: %w", err)
	}

	// Cache credential using same pattern as browser-sso.
	cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
	azureCredCacheMu.Lock()
	azureCredCache[cacheKey] = cred
	azureCredCacheMu.Unlock()
	creds["azure_cred_cache_key"] = cacheKey

	return listAzureSubscriptions(ctx, cred)
}

// realAzureDeviceCode implements Azure Device Code Flow authentication.
// It creates a DeviceCodeCredential that prints the device code and verification URL
// to stdout for the user to complete in their browser, then polls until authentication
// completes or times out.
func realAzureDeviceCode(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	tenantID := creds["tenantId"]
	if tenantID == "" {
		return nil, errors.New("tenantId is required for device code authentication")
	}

	// Use the Azure CLI well-known public client ID — no client secret required.
	const azureCLIClientID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"

	cred, err := azidentity.NewDeviceCodeCredential(&azidentity.DeviceCodeCredentialOptions{
		TenantID: tenantID,
		ClientID: azureCLIClientID,
		UserPrompt: func(ctx context.Context, msg azidentity.DeviceCodeMessage) error {
			// The SDK calls this callback with the device code and verification URL.
			// In a real browser-based UI flow, the frontend would display these.
			// For now, print to stdout — the frontend polls for the validation result.
			fmt.Printf("Azure Device Code: %s\n", msg.Message)
			return nil
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create device code credential: %w", err)
	}

	// Cache the live credential so the scanner can reuse it.
	cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
	azureCredCacheMu.Lock()
	azureCredCache[cacheKey] = cred
	azureCredCacheMu.Unlock()
	creds["azure_cred_cache_key"] = cacheKey

	// List subscriptions accessible with this credential.
	// This call triggers the device code flow — the user must complete browser auth
	// before this returns.
	return listAzureSubscriptions(ctx, cred)
}

// realAzureCertificate implements certificate-based Service Principal authentication.
// Supports PEM-encoded certificates (with or without private key in the same file)
// and optionally a password for encrypted private keys.
// The frontend sends the certificate content as a base64-encoded string in the
// "certificateData" credential field.
func realAzureCertificate(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	tenantID := creds["tenantId"]
	clientID := creds["clientId"]
	certData := creds["certificateData"]
	if tenantID == "" || clientID == "" || certData == "" {
		return nil, errors.New("tenantId, clientId, and certificateData are required for certificate authentication")
	}

	// Decode the base64-encoded certificate data.
	certBytes, err := base64.StdEncoding.DecodeString(certData)
	if err != nil {
		// Try raw (non-base64) — the frontend might send PEM content directly.
		certBytes = []byte(certData)
	}

	// Parse PEM certificates and private key.
	certs, key, err := azidentity.ParseCertificates(certBytes, []byte(creds["certificatePassword"]))
	if err != nil {
		return nil, fmt.Errorf("failed to parse certificate: %w", err)
	}

	cred, err := azidentity.NewClientCertificateCredential(tenantID, clientID, certs, key, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create certificate credential: %w", err)
	}

	// Cache the live credential so the scanner can reuse it.
	cacheKey := fmt.Sprintf("azcred-%d", time.Now().UnixNano())
	azureCredCacheMu.Lock()
	azureCredCache[cacheKey] = cred
	azureCredCacheMu.Unlock()
	creds["azure_cred_cache_key"] = cacheKey

	return listAzureSubscriptions(ctx, cred)
}

// realAzureValidator lists subscriptions using ClientSecretCredential.
// DefaultAzureCredential is explicitly prohibited — it may pick up ambient credentials
// from the developer machine and bypass the user-supplied credentials entirely.
func realAzureValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	switch creds["authMethod"] {
	case "browser-sso":
		return realAzureBrowserSSO(ctx, creds)
	case "az-cli":
		return realAzureCLI(ctx, creds)
	case "device_code", "device-code":
		return realAzureDeviceCode(ctx, creds)

	case "certificate":
		return realAzureCertificate(ctx, creds)
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

	return listAzureSubscriptions(ctx, cred)
}

// realGCPValidator validates GCP credentials and returns a project list.
// Supports four auth methods:
//   - "adc": Application Default Credentials (gcloud auth application-default login)
//   - "browser-oauth": Interactive browser consent flow with localhost redirect
//   - "workload-identity": Workload Identity Federation via configuration JSON
//   - "service-account" (default): parse service account JSON, return project_id
func realGCPValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	switch creds["authMethod"] {
	case "adc":
		return realGCPADCValidator(ctx, creds)
	case "browser-oauth":
		return realGCPBrowserOAuth(ctx, creds)
	case "workload-identity":
		return realGCPWorkloadIdentity(ctx, creds)
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

// realGCPBrowserOAuth implements interactive browser-based OAuth2 authentication for GCP.
// It starts a localhost redirect server, opens the system browser for user consent,
// receives the authorization code, and exchanges it for tokens.
// Uses the GCP OAuth2 client ID for installed applications.
// The token source is cached so the scanner can reuse it without a second browser popup.
func realGCPBrowserOAuth(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	clientID := creds["clientId"]
	clientSecret := creds["clientSecret"]
	if clientID == "" || clientSecret == "" {
		return nil, errors.New("clientId and clientSecret are required for browser OAuth — create OAuth credentials in the GCP Console")
	}

	// Start a localhost listener for the OAuth2 redirect.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("gcp browser-oauth: failed to start redirect listener: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	redirectURL := fmt.Sprintf("http://127.0.0.1:%d/callback", port)

	conf := &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Endpoint:     google.Endpoint,
		RedirectURL:  redirectURL,
		Scopes: []string{
			"https://www.googleapis.com/auth/compute.readonly",
			"https://www.googleapis.com/auth/ndev.clouddns.readonly",
			"https://www.googleapis.com/auth/cloudplatformprojects.readonly",
		},
	}

	// Generate state token for CSRF protection.
	state := fmt.Sprintf("gcpoauth-%d", time.Now().UnixNano())
	authURL := conf.AuthCodeURL(state, oauth2.AccessTypeOffline)

	// Channel to receive the authorization code (or error).
	type authResult struct {
		code string
		err  error
	}
	resultCh := make(chan authResult, 1)

	// HTTP handler for the OAuth2 redirect.
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("state") != state {
			resultCh <- authResult{err: errors.New("OAuth state mismatch")}
			fmt.Fprintf(w, "<html><body><h2>Authentication failed</h2><p>State mismatch — please try again.</p></body></html>")
			return
		}
		if errParam := r.URL.Query().Get("error"); errParam != "" {
			resultCh <- authResult{err: fmt.Errorf("OAuth error: %s — %s", errParam, r.URL.Query().Get("error_description"))}
			fmt.Fprintf(w, "<html><body><h2>Authentication failed</h2><p>%s</p></body></html>", r.URL.Query().Get("error_description"))
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			resultCh <- authResult{err: errors.New("no authorization code received")}
			fmt.Fprintf(w, "<html><body><h2>Authentication failed</h2><p>No authorization code received.</p></body></html>")
			return
		}
		resultCh <- authResult{code: code}
		fmt.Fprintf(w, "<html><body><h2>Authentication successful</h2><p>You can close this tab and return to the application.</p></body></html>")
	})

	srv := &http.Server{Handler: mux}
	go func() {
		_ = srv.Serve(listener)
	}()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	// Open the browser for user consent.
	_ = pkgbrowser.OpenURL(authURL)

	// Wait for the authorization code with a 120-second timeout.
	var code string
	select {
	case result := <-resultCh:
		if result.err != nil {
			return nil, fmt.Errorf("gcp browser-oauth: %w", result.err)
		}
		code = result.code
	case <-time.After(120 * time.Second):
		return nil, errors.New("gcp browser-oauth: timed out waiting for browser consent — please try again")
	case <-ctx.Done():
		return nil, errors.New("gcp browser-oauth: cancelled")
	}

	// Exchange the authorization code for tokens.
	token, err := conf.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("gcp browser-oauth: token exchange failed: %w", err)
	}

	ts := conf.TokenSource(ctx, token)

	// Cache the token source for scanner reuse.
	cacheKey := fmt.Sprintf("gcpts-%d", time.Now().UnixNano())
	gcpTokenCacheMu.Lock()
	gcpTokenCache[cacheKey] = ts
	gcpTokenCacheMu.Unlock()
	creds["gcp_token_cache_key"] = cacheKey

	// List accessible projects to populate the subscription selector.
	httpClient := oauth2.NewClient(ctx, ts)
	resp, err := httpClient.Get("https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE")
	if err != nil {
		return nil, fmt.Errorf("gcp browser-oauth: list projects: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gcp browser-oauth: list projects returned HTTP %d", resp.StatusCode)
	}

	var projectsResult struct {
		Projects []struct {
			ProjectID string `json:"projectId"`
			Name      string `json:"name"`
		} `json:"projects"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&projectsResult); err != nil {
		return nil, fmt.Errorf("gcp browser-oauth: decode projects: %w", err)
	}

	if len(projectsResult.Projects) == 0 {
		return nil, errors.New("gcp browser-oauth: no accessible GCP projects found for this account")
	}

	items := make([]SubscriptionItem, 0, len(projectsResult.Projects))
	for _, p := range projectsResult.Projects {
		name := p.Name
		if name == "" {
			name = p.ProjectID
		}
		items = append(items, SubscriptionItem{ID: p.ProjectID, Name: name})
	}
	return items, nil
}

// realGCPWorkloadIdentity validates GCP Workload Identity Federation (WIF) credentials.
// The user provides a WIF configuration JSON file (type "external_account") that contains
// the federation settings (audience, subject token source, service account impersonation URL).
// google.CredentialsFromJSON natively supports external_account type.
func realGCPWorkloadIdentity(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	wifJSON := creds["workloadIdentityJson"]
	if wifJSON == "" {
		return nil, errors.New("workloadIdentityJson is required — download the WIF configuration file from the GCP Console")
	}

	// Structural validation: parse the JSON and verify type.
	var wifFields struct {
		Type                           string `json:"type"`
		ServiceAccountImpersonationURL string `json:"service_account_impersonation_url"`
	}
	if err := json.Unmarshal([]byte(wifJSON), &wifFields); err != nil {
		return nil, fmt.Errorf("gcp: invalid WIF configuration JSON: %w", err)
	}
	if wifFields.Type != "external_account" {
		return nil, fmt.Errorf("gcp: expected type \"external_account\" in WIF configuration, got %q", wifFields.Type)
	}

	// google.CredentialsFromJSON handles external_account type natively —
	// it configures the token exchange, optional service account impersonation,
	// and returns a TokenSource that transparently handles refresh.
	googleCreds, err := google.CredentialsFromJSON(ctx, []byte(wifJSON),
		"https://www.googleapis.com/auth/compute.readonly",
		"https://www.googleapis.com/auth/ndev.clouddns.readonly",
		"https://www.googleapis.com/auth/cloudplatformprojects.readonly",
	)
	if err != nil {
		return nil, fmt.Errorf("gcp wif: failed to parse WIF configuration: %w", err)
	}

	ts := googleCreds.TokenSource

	// Cache the token source for scanner reuse.
	cacheKey := fmt.Sprintf("gcpts-%d", time.Now().UnixNano())
	gcpTokenCacheMu.Lock()
	gcpTokenCache[cacheKey] = ts
	gcpTokenCacheMu.Unlock()
	creds["gcp_token_cache_key"] = cacheKey

	// Extract project ID from the WIF config if available (via service account impersonation URL
	// which contains the project's service account). Otherwise request a project_id from the user.
	projectID := ""
	if wifFields.ServiceAccountImpersonationURL != "" {
		// URL format: https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/SA@PROJECT.iam.gserviceaccount.com:generateAccessToken
		// Extract PROJECT from the service account email.
		if idx := strings.Index(wifFields.ServiceAccountImpersonationURL, "@"); idx != -1 {
			after := wifFields.ServiceAccountImpersonationURL[idx+1:]
			if dotIAM := strings.Index(after, ".iam.gserviceaccount.com"); dotIAM != -1 {
				projectID = after[:dotIAM]
			}
		}
	}

	// Try listing projects; if that fails (WIF may not have cloudplatformprojects scope),
	// fall back to returning the extracted project ID.
	httpClient := oauth2.NewClient(ctx, ts)
	resp, err := httpClient.Get("https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState%3AACTIVE")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			var projectsResult struct {
				Projects []struct {
					ProjectID string `json:"projectId"`
					Name      string `json:"name"`
				} `json:"projects"`
			}
			if decErr := json.NewDecoder(resp.Body).Decode(&projectsResult); decErr == nil && len(projectsResult.Projects) > 0 {
				items := make([]SubscriptionItem, 0, len(projectsResult.Projects))
				for _, p := range projectsResult.Projects {
					name := p.Name
					if name == "" {
						name = p.ProjectID
					}
					items = append(items, SubscriptionItem{ID: p.ProjectID, Name: name})
				}
				return items, nil
			}
		}
	}

	// Fallback: return the project ID extracted from the SA impersonation URL.
	if projectID != "" {
		return []SubscriptionItem{{ID: projectID, Name: projectID + " (from WIF config)"}}, nil
	}

	// Last resort: check if user provided a project_id in credentials.
	if pid := creds["projectId"]; pid != "" {
		return []SubscriptionItem{{ID: pid, Name: pid}}, nil
	}

	return nil, errors.New("gcp wif: unable to determine project ID — provide a projectId alongside the WIF configuration")
}

// realADValidator validates Active Directory / WinRM credentials by opening a
// WinRM connection and running a lightweight PowerShell probe ($PSVersionTable).
// Supports NTLM (default) and Kerberos (pure Go via gokrb5) auth methods.
// The frontend sends a comma-separated "servers" field; the validator probes the first
// server and returns one SubscriptionItem per server on success.
func realADValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	// Route Kerberos auth to its dedicated validator.
	if creds["authMethod"] == "kerberos" {
		return realADKerberosValidator(ctx, creds)
	}

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

	// Build a WinRM client with NTLM via the shared BuildNTLMClient helper.
	// Pass HTTPS options if the user enabled SSL transport.
	var clientOpts []ad.ClientOption
	if creds["useSSL"] == "true" {
		clientOpts = append(clientOpts, ad.WithHTTPS())
	}
	if creds["insecureSkipVerify"] == "true" {
		clientOpts = append(clientOpts, ad.WithInsecureSkipVerify())
	}
	client, err := ad.BuildNTLMClient(host, username, password, clientOpts...)
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

			c, cerr := ad.BuildNTLMClient(host, username, password, clientOpts...)
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

// realBluecatValidator validates Bluecat Address Manager credentials by attempting
// v2 session auth first, then falling back to v1 legacy auth.
// Returns a single SubscriptionItem identifying the detected API version.
func realBluecatValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	baseURL := strings.TrimRight(creds["bluecat_url"], "/")
	username := creds["bluecat_username"]
	password := creds["bluecat_password"]
	if baseURL == "" || username == "" || password == "" {
		return nil, errors.New("bluecat_url, bluecat_username, and bluecat_password are required")
	}

	skipTLS := creds["skip_tls"] == "true"
	client := &http.Client{Timeout: 15 * time.Second}
	if skipTLS {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		}
	}

	// Try v2 session auth first.
	v2Body, _ := json.Marshal(map[string]string{"username": username, "password": password})
	v2Req, _ := http.NewRequestWithContext(ctx, "POST", baseURL+"/api/v2/sessions", bytes.NewReader(v2Body))
	v2Req.Header.Set("Content-Type", "application/json")
	v2Req.Header.Set("Accept", "application/json")

	resp, err := client.Do(v2Req)
	if err == nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 400 {
			return []SubscriptionItem{{ID: "bluecat", Name: "BlueCat (API v2)"}}, nil
		}
	}

	// Fallback to v1 legacy auth.
	v1URL := fmt.Sprintf("%s/Services/REST/v1/login?username=%s&password=%s",
		baseURL, url.QueryEscape(username), url.QueryEscape(password))
	v1Req, _ := http.NewRequestWithContext(ctx, "GET", v1URL, nil)
	v1Req.Header.Set("Accept", "application/json")

	resp, err = client.Do(v1Req)
	if err != nil {
		return nil, fmt.Errorf("bluecat: connection failed: %w", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("bluecat: authentication failed (v2 and v1 both returned errors)")
	}

	return []SubscriptionItem{{ID: "bluecat", Name: "BlueCat (API v1)"}}, nil
}

// realEfficientIPValidator validates EfficientIP SOLIDserver credentials.
// Tries HTTP Basic auth first, then native X-IPM headers with base64-encoded credentials.
// Returns a single SubscriptionItem identifying the detected auth mode.
func realEfficientIPValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	baseURL := strings.TrimRight(creds["efficientip_url"], "/")
	username := creds["efficientip_username"]
	password := creds["efficientip_password"]
	if baseURL == "" || username == "" || password == "" {
		return nil, errors.New("efficientip_url, efficientip_username, and efficientip_password are required")
	}

	skipTLS := creds["skip_tls"] == "true"
	client := &http.Client{Timeout: 15 * time.Second}
	if skipTLS {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		}
	}

	probeURL := baseURL + "/rest/member_list?limit=1&offset=0"

	// Try Basic auth.
	basicReq, _ := http.NewRequestWithContext(ctx, "GET", probeURL, nil)
	basicReq.SetBasicAuth(username, password)
	basicReq.Header.Set("Accept", "application/json")

	resp, err := client.Do(basicReq)
	if err == nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 400 {
			return []SubscriptionItem{{ID: "efficientip", Name: "EfficientIP (Basic auth)"}}, nil
		}
	}

	// Try native auth.
	nativeReq, _ := http.NewRequestWithContext(ctx, "GET", probeURL, nil)
	nativeReq.Header.Set("X-IPM-Username", base64.StdEncoding.EncodeToString([]byte(username)))
	nativeReq.Header.Set("X-IPM-Password", base64.StdEncoding.EncodeToString([]byte(password)))
	nativeReq.Header.Set("Content-Type", "application/json")
	nativeReq.Header.Set("Accept", "application/json")

	resp, err = client.Do(nativeReq)
	if err != nil {
		return nil, fmt.Errorf("efficientip: connection failed: %w", err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("efficientip: authentication failed (both basic and native)")
	}

	return []SubscriptionItem{{ID: "efficientip", Name: "EfficientIP (Native auth)"}}, nil
}

// realNiosWAPIValidator validates NIOS WAPI credentials by resolving the WAPI version
// and fetching the capacity report. Returns Grid Members as SubscriptionItems
// so the Sources step can display them for member selection (same UX as backup upload).
func realNiosWAPIValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	baseURL := strings.TrimRight(creds["wapi_url"], "/")
	username := creds["wapi_username"]
	password := creds["wapi_password"]
	if baseURL == "" || username == "" || password == "" {
		return nil, errors.New("wapi_url, wapi_username, and wapi_password are required")
	}

	skipTLS := creds["skip_tls"] == "true"
	client := &http.Client{Timeout: 15 * time.Second}
	if skipTLS {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		}
	}

	// Strip embedded /wapi/vX.Y.Z if present and extract version.
	wapiVersionRE := regexp.MustCompile(`(?i)/wapi/v(?P<version>\d+(?:\.\d+)+)`)
	explicitVersion := strings.TrimSpace(creds["wapi_version"])
	if strings.HasPrefix(strings.ToLower(explicitVersion), "v") {
		explicitVersion = explicitVersion[1:]
	}

	// Normalize base URL.
	if loc := wapiVersionRE.FindStringIndex(baseURL); loc != nil {
		if explicitVersion == "" {
			match := wapiVersionRE.FindStringSubmatch(baseURL)
			if len(match) >= 2 {
				explicitVersion = match[1]
			}
		}
		baseURL = strings.TrimRight(baseURL[:loc[0]], "/")
	}

	// Resolve WAPI version.
	version := explicitVersion
	if version == "" {
		// Probe candidate versions from newest to oldest.
		candidates := []string{"2.13.7", "2.13.6", "2.13.5", "2.13.4", "2.12.3", "2.12.2", "2.11.3", "2.10.5", "2.9.13"}
		for _, v := range candidates {
			probeURL := fmt.Sprintf("%s/wapi/v%s/grid?_max_results=1&_return_fields=_ref", baseURL, v)
			req, _ := http.NewRequestWithContext(ctx, "GET", probeURL, nil)
			req.SetBasicAuth(username, password)
			resp, err := client.Do(req)
			if err != nil {
				continue
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode < 400 {
				version = v
				break
			}
			if resp.StatusCode == 401 || resp.StatusCode == 403 {
				return nil, fmt.Errorf("nios wapi: authentication failed (HTTP %d)", resp.StatusCode)
			}
		}
		if version == "" {
			return nil, errors.New("nios wapi: unable to resolve WAPI version; verify URL and credentials")
		}
	}

	// Fetch capacity report to extract Grid Member list.
	capURL := fmt.Sprintf("%s/wapi/v%s/capacityreport?_return_fields=name,role,total_objects", baseURL, version)
	capReq, _ := http.NewRequestWithContext(ctx, "GET", capURL, nil)
	capReq.SetBasicAuth(username, password)

	resp, err := client.Do(capReq)
	if err != nil {
		return nil, fmt.Errorf("nios wapi: capacity report request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("nios wapi: capacity report returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("nios wapi: reading capacity report: %w", err)
	}

	var members []map[string]interface{}
	if err := json.Unmarshal(body, &members); err != nil {
		return nil, fmt.Errorf("nios wapi: decoding capacity report: %w", err)
	}

	if len(members) == 0 {
		return nil, errors.New("nios wapi: no Grid Members found in capacity report")
	}

	items := make([]SubscriptionItem, 0, len(members))
	for _, m := range members {
		name := strings.TrimSpace(fmt.Sprintf("%v", m["name"]))
		if name == "" {
			continue
		}
		role := strings.TrimSpace(fmt.Sprintf("%v", m["role"]))
		displayName := name
		if role != "" {
			displayName = name + " (" + role + ")"
		}
		items = append(items, SubscriptionItem{ID: name, Name: displayName})
	}

	if len(items) == 0 {
		return nil, errors.New("nios wapi: capacity report contained no valid members")
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

// realADKerberosValidator validates Kerberos authentication by obtaining a TGT from
// the KDC using username/password, then building a Kerberos-authenticated WinRM client
// to probe the first DC. Uses pure Go (gokrb5) — does not require a domain-joined
// machine or Windows SSPI.
func realADKerberosValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	servers := parseServers(creds["servers"])
	if len(servers) == 0 {
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
	realm := creds["realm"]
	kdc := creds["kdc"]

	if host == "" || username == "" || password == "" {
		return nil, errors.New("server address, username, and password are required")
	}
	if realm == "" {
		return nil, errors.New("realm is required for Kerberos authentication (e.g. CORP.EXAMPLE.COM)")
	}
	if kdc == "" {
		// Default KDC to the first server host on standard Kerberos port.
		kdc = host + ":88"
	}

	// Build Kerberos-authenticated WinRM client via the shared helper.
	var clientOpts []ad.ClientOption
	if creds["useSSL"] == "true" {
		clientOpts = append(clientOpts, ad.WithHTTPS())
	}
	if creds["insecureSkipVerify"] == "true" {
		clientOpts = append(clientOpts, ad.WithInsecureSkipVerify())
	}
	client, err := ad.BuildKerberosClient(host, username, password, realm, kdc, clientOpts...)
	if err != nil {
		return nil, fmt.Errorf("Kerberos WinRM client error: %w", err)
	}

	// Wrap the connectivity probe in a hard 10s deadline.
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var outBuf, errBuf strings.Builder
	exitCode, err := client.RunWithContext(probeCtx,
		winrm.Powershell(`$PSVersionTable.PSVersion.Major`),
		&outBuf, &errBuf,
	)
	if err != nil {
		return nil, fmt.Errorf("Kerberos WinRM connection failed: %w", err)
	}
	if exitCode != 0 {
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = strings.TrimSpace(outBuf.String())
		}
		return nil, fmt.Errorf("Kerberos WinRM probe failed (exit %d): %s", exitCode, msg)
	}

	// Build subscription items for each server.
	items := make([]SubscriptionItem, 0, len(servers))
	for _, s := range servers {
		items = append(items, SubscriptionItem{ID: s, Name: s + " (Kerberos)"})
	}
	return items, nil
}
