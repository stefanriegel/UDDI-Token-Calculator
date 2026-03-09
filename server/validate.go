package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	armsubscriptions "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armsubscriptions"
	"github.com/go-chi/chi/v5"

	"github.com/infoblox/uddi-go-token-calculator/internal/session"
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
	sess := h.store.New()
	storeCredentials(sess, provider, req.AuthMethod, req.Credentials)

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
		sess.AWS = &session.AWSCredentials{
			AuthMethod:      authMethod,
			AccessKeyID:     creds["accessKeyId"],
			SecretAccessKey: creds["secretAccessKey"],
			Region:          creds["region"],
			ProfileName:     creds["profileName"],
			RoleARN:         creds["roleArn"],
		}
	case "azure":
		sess.Azure = &session.AzureCredentials{
			AuthMethod:   authMethod,
			TenantID:     creds["tenantId"],
			ClientID:     creds["clientId"],
			ClientSecret: creds["clientSecret"],
		}
	case "gcp":
		sess.GCP = &session.GCPCredentials{
			AuthMethod:         authMethod,
			ServiceAccountJSON: creds["service_account_json"],
		}
	case "ad":
		sess.AD = &session.ADCredentials{
			AuthMethod: authMethod,
			Host:       creds["host"],
			Username:   creds["username"],
			Password:   creds["password"],
			Domain:     creds["domain"],
		}
	}
}

// realAWSValidator calls sts:GetCallerIdentity with the supplied static credentials.
// Only "access_key" authMethod is supported in Phase 2; others return a coming-soon message.
func realAWSValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	switch creds["authMethod"] {
	case "sso", "profile", "assume_role":
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
			credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, ""),
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

// realAzureValidator lists subscriptions using ClientSecretCredential.
// DefaultAzureCredential is explicitly prohibited — it may pick up ambient credentials
// from the developer machine and bypass the user-supplied credentials entirely.
func realAzureValidator(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	if creds["authMethod"] == "device_code" {
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

	return items, nil
}

// realGCPValidator performs Phase 2 structural validation only — real API calls are
// deferred to Phase 5. If service_account_json is non-empty the credentials are
// accepted as structurally valid and a stub project list is returned.
func realGCPValidator(_ context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	if creds["authMethod"] == "browser_oauth" {
		return nil, errors.New("Coming soon — not yet implemented in this version")
	}

	if creds["service_account_json"] == "" {
		return nil, errors.New("service_account_json is required")
	}

	return []SubscriptionItem{{
		ID:   "stub-gcp-project",
		Name: "GCP Project (stub — connect in Phase 5)",
	}}, nil
}

// realADValidator performs Phase 2 structural validation only — real WinRM calls are
// deferred to Phase 6. If host, username, and password are all non-empty the credentials
// are accepted as structurally valid and a stub DC list is returned.
func realADValidator(_ context.Context, creds map[string]string) ([]SubscriptionItem, error) {
	if creds["authMethod"] == "kerberos" {
		return nil, errors.New("Coming soon — not yet implemented in this version")
	}

	host := creds["host"]
	username := creds["username"]
	password := creds["password"]
	if host == "" || username == "" || password == "" {
		return nil, errors.New("host, username, and password are required")
	}

	return []SubscriptionItem{{
		ID:   host,
		Name: "AD Domain Controller " + host,
	}}, nil
}
