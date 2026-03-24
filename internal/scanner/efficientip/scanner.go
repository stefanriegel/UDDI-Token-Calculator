// Package efficientip implements scanner.Scanner for EfficientIP SOLIDserver DDI.
// It authenticates via HTTP Basic first, falling back to native X-IPM headers with
// base64-encoded credentials, or via SHA3-256 HMAC-like token auth (SDS scheme).
// Resources are collected from REST API endpoints with pagination and optional
// site ID filtering. API version "v2" routes requests through /api/v2.0/ paths.
package efficientip

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/crypto/sha3"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

const (
	pageSize       = 1000
	maxRetries     = 3
	backoffBase    = 1 * time.Second
	requestTimeout = 30 * time.Second
)

// supportedDNSRecordTypes matches the Python reference SUPPORTED_DNS_RECORD_TYPES.
var supportedDNSRecordTypes = map[string]struct{}{
	"A": {}, "AAAA": {}, "CNAME": {}, "MX": {}, "TXT": {},
	"CAA": {}, "SRV": {}, "SVCB": {}, "HTTPS": {}, "PTR": {},
	"NS": {}, "SOA": {}, "NAPTR": {},
}

// retryStatuses are HTTP status codes that trigger a retry.
var retryStatuses = map[int]struct{}{
	429: {}, 500: {}, 502: {}, 503: {}, 504: {},
}

// v2Paths maps legacy EfficientIP service names to their API v2.0 path segments.
var v2Paths = map[string]string{
	"member_list":      "app/node/list",
	"dns_view_list":    "dns/view/list",
	"dns_zone_list":    "dns/zone/list",
	"dns_rr_list":      "dns/rr/list",
	"ip_site_list":     "ipam/site/list",
	"ip_subnet_list":   "ipam/subnet/list",
	"ip_subnet6_list":  "ipam/subnet6/list",
	"ip_pool_list":     "ipam/pool/list",
	"ip_pool6_list":    "ipam/pool6/list",
	"ip_address_list":  "ipam/address/list",
	"ip_address6_list": "ipam/address6/list",
	"dhcp_scope_list":  "dhcp/scope/list",
	"dhcp_scope6_list": "dhcp/scope6/list",
	"dhcp_range_list":  "dhcp/range/list",
	"dhcp_range6_list": "dhcp/range6/list",
}

// Scanner implements scanner.Scanner for EfficientIP SOLIDserver.
type Scanner struct{}

// New returns a ready-to-use EfficientIP Scanner.
func New() *Scanner { return &Scanner{} }

// Scan implements scanner.Scanner. It extracts credentials, authenticates,
// collects DNS/IPAM/DHCP resources, and returns FindingRows.
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	baseURL := strings.TrimRight(req.Credentials["efficientip_url"], "/")
	username := req.Credentials["efficientip_username"]
	password := req.Credentials["efficientip_password"]
	skipTLS := req.Credentials["skip_tls"] == "true"

	authMethod := req.Credentials["efficientip_auth_method"]
	if authMethod == "" {
		authMethod = "credentials"
	}
	tokenID := req.Credentials["efficientip_token_id"]
	tokenSecret := req.Credentials["efficientip_token_secret"]
	apiVersion := req.Credentials["efficientip_api_version"]
	if apiVersion == "" {
		apiVersion = "legacy"
	}

	if baseURL == "" {
		return nil, fmt.Errorf("efficientip: url is required")
	}
	if authMethod == "token" {
		if tokenID == "" || tokenSecret == "" {
			return nil, fmt.Errorf("efficientip: token_id and token_secret are required for token auth")
		}
	} else {
		if username == "" || password == "" {
			return nil, fmt.Errorf("efficientip: url, username, and password are required")
		}
	}

	// Parse site IDs from comma-separated string
	var siteIDs []string
	if raw := req.Credentials["site_ids"]; raw != "" {
		for _, id := range strings.Split(raw, ",") {
			id = strings.TrimSpace(id)
			if id != "" {
				siteIDs = append(siteIDs, id)
			}
		}
	}

	client := s.buildHTTPClient(skipTLS)

	// Authenticate
	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "auth", Status: "in_progress", Message: "Authenticating"})
	authMode, err := s.authenticate(ctx, baseURL, authMethod, apiVersion, username, password, tokenID, tokenSecret, client)
	if err != nil {
		publish(scanner.Event{Type: "error", Provider: "efficientip", Resource: "auth", Status: "error", Message: err.Error()})
		return nil, fmt.Errorf("efficientip: authentication failed: %w", err)
	}
	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "auth", Status: "done", Message: fmt.Sprintf("Authenticated (%s mode)", authMode)})

	whereClause := s.siteWhereClause(siteIDs)

	// Collect DNS
	dnsRows, err := s.collectDNS(ctx, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret, client, whereClause, publish)
	if err != nil {
		return nil, err
	}

	// Collect IPAM + DHCP
	ipamRows, err := s.collectIPAMDHCP(ctx, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret, client, whereClause, publish)
	if err != nil {
		return nil, err
	}

	rows := append(dnsRows, ipamRows...)

	publish(scanner.Event{Type: "provider_complete", Provider: "efficientip", Status: "done", Count: len(rows)})
	return rows, nil
}

// buildHTTPClient creates an http.Client, optionally skipping TLS verification.
func (s *Scanner) buildHTTPClient(skipTLS bool) *http.Client {
	client := &http.Client{Timeout: requestTimeout}
	if skipTLS {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
		}
	}
	return client
}

// buildEndpointURL returns the full base URL for a given service and API version.
// For apiVersion == "v2" and a known service, returns baseURL + "/api/v2.0/" + <path> + "?".
// Otherwise returns baseURL + "/rest/" + service + "?".
// The trailing "?" lets callers concatenate params.Encode() directly.
func buildEndpointURL(baseURL, apiVersion, service string) string {
	if apiVersion == "v2" {
		if v2Path, ok := v2Paths[service]; ok {
			return baseURL + "/api/v2.0/" + v2Path + "?"
		}
	}
	return baseURL + "/rest/" + service + "?"
}

// setTokenAuth computes a SHA3-256 HMAC-like signature over the request method
// and full URL (including query parameters) and sets the SDS Authorization header.
// The signature input is: "<tokenSecret>\n<unixTimestamp>\n<METHOD>\n<fullURL>".
// Call this AFTER the request URL (including query params) is fully constructed.
func setTokenAuth(req *http.Request, tokenID, tokenSecret, fullURL string) {
	ts := time.Now().Unix()
	s := fmt.Sprintf("%s\n%d\n%s\n%s", tokenSecret, ts, req.Method, fullURL)
	sum := sha3.Sum256([]byte(s))
	req.Header.Set("Authorization", fmt.Sprintf("SDS %s:%x", tokenID, sum))
	req.Header.Set("X-SDS-TS", fmt.Sprintf("%d", ts))
	req.Header.Set("Accept", "application/json")
}

// authenticate tries HTTP Basic auth first, then falls back to native X-IPM headers,
// or uses token auth (SDS scheme) when authMode is "token".
func (s *Scanner) authenticate(ctx context.Context, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret string, client *http.Client) (string, error) {
	if authMode == "token" {
		// Token auth: probe with SHA3 signature, skip basic/native.
		probeURL := buildEndpointURL(baseURL, apiVersion, "member_list") + "limit=1&offset=0"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
		if err != nil {
			return "", err
		}
		setTokenAuth(req, tokenID, tokenSecret, req.URL.String())
		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("token auth probe failed: %w", err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 400 {
			return "token", nil
		}
		return "", fmt.Errorf("token auth probe returned HTTP %d", resp.StatusCode)
	}

	// Credentials auth: try Basic first, then native X-IPM headers.
	probeURL := baseURL + "/rest/member_list?limit=1&offset=0"

	// Try Basic auth
	basicReq, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
	if err != nil {
		return "", err
	}
	basicReq.SetBasicAuth(username, password)
	basicReq.Header.Set("Accept", "application/json")

	resp, err := client.Do(basicReq)
	if err == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode < 400 {
			return "basic", nil
		}
	}

	// Try native auth
	nativeReq, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURL, nil)
	if err != nil {
		return "", err
	}
	s.setNativeHeaders(nativeReq, username, password)

	resp, err = client.Do(nativeReq)
	if err != nil {
		return "", fmt.Errorf("both basic and native auth failed: %w", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode < 400 {
		return "native", nil
	}

	return "", fmt.Errorf("authentication failed for both modes (basic and native)")
}

// setNativeHeaders sets X-IPM-Username and X-IPM-Password with base64-encoded values.
func (s *Scanner) setNativeHeaders(req *http.Request, username, password string) {
	req.Header.Set("X-IPM-Username", base64.StdEncoding.EncodeToString([]byte(username)))
	req.Header.Set("X-IPM-Password", base64.StdEncoding.EncodeToString([]byte(password)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
}

// setAuth applies the appropriate auth headers/credentials to a request.
func (s *Scanner) setAuth(req *http.Request, authMode, username, password, tokenID, tokenSecret string) {
	switch authMode {
	case "token":
		setTokenAuth(req, tokenID, tokenSecret, req.URL.String())
	case "basic":
		req.SetBasicAuth(username, password)
		req.Header.Set("Accept", "application/json")
	default:
		s.setNativeHeaders(req, username, password)
	}
}

// siteWhereClause builds the WHERE clause for site-filtered endpoints.
func (s *Scanner) siteWhereClause(siteIDs []string) string {
	var conditions []string
	for _, id := range siteIDs {
		if id != "" {
			conditions = append(conditions, fmt.Sprintf("site_id='%s'", id))
		}
	}
	if len(conditions) == 0 {
		return ""
	}
	if len(conditions) == 1 {
		return conditions[0]
	}
	return "(" + strings.Join(conditions, " or ") + ")"
}

// countService paginates through a REST endpoint and counts items.
// Returns total count, collected rows (if includeRows), and any error.
func (s *Scanner) countService(
	ctx context.Context,
	baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret string,
	client *http.Client,
	service, whereClause string,
	includeRows bool,
) (int, []map[string]interface{}, error) {
	total := 0
	var allRows []map[string]interface{}
	offset := 0

	for {
		params := url.Values{}
		params.Set("limit", fmt.Sprintf("%d", pageSize))
		params.Set("offset", fmt.Sprintf("%d", offset))
		if whereClause != "" {
			params.Set("WHERE", whereClause)
		}

		reqURL := buildEndpointURL(baseURL, apiVersion, service) + params.Encode()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
		if err != nil {
			return 0, nil, err
		}
		s.setAuth(req, authMode, username, password, tokenID, tokenSecret)

		body, err := s.doWithRetry(client, req)
		if err != nil {
			return 0, nil, err
		}

		var items []map[string]interface{}
		if err := json.Unmarshal(body, &items); err != nil {
			// Try unwrapping from object with known keys
			var wrapper map[string]json.RawMessage
			if json.Unmarshal(body, &wrapper) == nil {
				for _, key := range []string{"items", "data", "result"} {
					if raw, ok := wrapper[key]; ok {
						if json.Unmarshal(raw, &items) == nil {
							break
						}
					}
				}
			}
		}

		total += len(items)
		if includeRows {
			allRows = append(allRows, items...)
		}

		if len(items) < pageSize {
			break
		}
		offset += pageSize
	}

	return total, allRows, nil
}

// doWithRetry executes an HTTP request with exponential backoff retry on 429/5xx.
func (s *Scanner) doWithRetry(client *http.Client, req *http.Request) ([]byte, error) {
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			if attempt < maxRetries-1 {
				sleep := time.Duration(math.Pow(2, float64(attempt))) * backoffBase
				time.Sleep(sleep)
			}
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if _, retry := retryStatuses[resp.StatusCode]; retry {
			lastErr = fmt.Errorf("HTTP %d from %s", resp.StatusCode, req.URL.Path)
			if attempt < maxRetries-1 {
				sleep := time.Duration(math.Pow(2, float64(attempt))) * backoffBase
				if ra := resp.Header.Get("Retry-After"); ra != "" {
					if secs := parseRetryAfter(ra); secs > 0 {
						sleep = time.Duration(secs) * time.Second
					}
				}
				time.Sleep(sleep)
			}
			continue
		}

		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, req.URL.Path)
		}
		return body, nil
	}
	return nil, fmt.Errorf("request failed after %d retries: %w", maxRetries, lastErr)
}

func parseRetryAfter(val string) int {
	var secs int
	if _, err := fmt.Sscanf(val, "%d", &secs); err == nil && secs > 0 {
		return secs
	}
	return 0
}

// collectDNS collects DNS views, zones, and records with supported/unsupported split.
func (s *Scanner) collectDNS(
	ctx context.Context,
	baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret string,
	client *http.Client,
	whereClause string,
	publish func(scanner.Event),
) ([]calculator.FindingRow, error) {
	var rows []calculator.FindingRow
	start := time.Now()

	// DNS Views
	views, _, err := s.countService(ctx, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret, client, "dns_view_list", whereClause, false)
	if err != nil {
		return nil, fmt.Errorf("dns_view_list: %w", err)
	}
	rows = append(rows, makeFinding("EfficientIP DNS Views", views))
	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "dns_views", Count: views, Status: "done", DurMS: ms(start)})

	// DNS Zones
	start = time.Now()
	zones, _, err := s.countService(ctx, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret, client, "dns_zone_list", whereClause, false)
	if err != nil {
		return nil, fmt.Errorf("dns_zone_list: %w", err)
	}
	rows = append(rows, makeFinding("EfficientIP DNS Zones", zones))
	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "dns_zones", Count: zones, Status: "done", DurMS: ms(start)})

	// DNS Records (need rows for type split)
	start = time.Now()
	_, records, err := s.countService(ctx, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret, client, "dns_rr_list", whereClause, true)
	if err != nil {
		return nil, fmt.Errorf("dns_rr_list: %w", err)
	}

	supported, unsupported := splitDNSRecords(records)
	rows = append(rows, makeFinding("EfficientIP DNS Records (Supported Types)", supported))
	rows = append(rows, makeFinding("EfficientIP DNS Records (Unsupported Types)", unsupported))
	publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: "dns_records", Count: supported + unsupported, Status: "done", DurMS: ms(start)})

	return rows, nil
}

// splitDNSRecords separates DNS records into supported and unsupported types.
func splitDNSRecords(records []map[string]interface{}) (supported, unsupported int) {
	for _, rec := range records {
		rrType := ""
		for _, key := range []string{"rr_type", "type", "record_type", "rrtype"} {
			if v, ok := rec[key]; ok && v != nil {
				rrType = strings.ToUpper(fmt.Sprintf("%v", v))
				if rrType != "" {
					break
				}
			}
		}
		if rrType == "" {
			unsupported++
			continue
		}
		if _, ok := supportedDNSRecordTypes[rrType]; ok {
			supported++
		} else {
			unsupported++
		}
	}
	return
}

// collectIPAMDHCP collects IPAM and DHCP resources.
func (s *Scanner) collectIPAMDHCP(
	ctx context.Context,
	baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret string,
	client *http.Client,
	whereClause string,
	publish func(scanner.Event),
) ([]calculator.FindingRow, error) {
	type resource struct {
		label   string
		service string
		event   string
	}
	resources := []resource{
		{"EfficientIP IP Sites", "ip_site_list", "ip_sites"},
		{"EfficientIP IP4 Subnets", "ip_subnet_list", "ip4_subnets"},
		{"EfficientIP IP6 Subnets", "ip_subnet6_list", "ip6_subnets"},
		{"EfficientIP IP4 Pools", "ip_pool_list", "ip4_pools"},
		{"EfficientIP IP6 Pools", "ip_pool6_list", "ip6_pools"},
		{"EfficientIP IP4 Addresses", "ip_address_list", "ip4_addresses"},
		{"EfficientIP IP6 Addresses", "ip_address6_list", "ip6_addresses"},
		{"EfficientIP DHCP4 Scopes", "dhcp_scope_list", "dhcp4_scopes"},
		{"EfficientIP DHCP6 Scopes", "dhcp_scope6_list", "dhcp6_scopes"},
		{"EfficientIP DHCP4 Ranges", "dhcp_range_list", "dhcp4_ranges"},
		{"EfficientIP DHCP6 Ranges", "dhcp_range6_list", "dhcp6_ranges"},
	}

	var rows []calculator.FindingRow
	for _, res := range resources {
		start := time.Now()
		count, _, err := s.countService(ctx, baseURL, authMode, apiVersion, username, password, tokenID, tokenSecret, client, res.service, whereClause, false)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", res.service, err)
		}
		rows = append(rows, makeFinding(res.label, count))
		publish(scanner.Event{Type: "resource_progress", Provider: "efficientip", Resource: res.event, Count: count, Status: "done", DurMS: ms(start)})
	}
	return rows, nil
}

// makeFinding creates a FindingRow for an EfficientIP resource. All EfficientIP
// resources map to DDI Objects category (25 tokens per unit).
func makeFinding(item string, count int) calculator.FindingRow {
	return calculator.FindingRow{
		Provider:         "efficientip",
		Source:           "efficientip",
		Region:           "",
		Category:         calculator.CategoryDDIObjects,
		Item:             item,
		Count:            count,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
	}
}

func ceilDiv(n, d int) int {
	if n == 0 {
		return 0
	}
	return (n + d - 1) / d
}

func ms(start time.Time) int64 {
	return time.Since(start).Milliseconds()
}
