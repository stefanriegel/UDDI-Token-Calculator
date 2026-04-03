// Package bluecat implements scanner.Scanner for Bluecat Address Manager.
// It authenticates via the v2 REST API (preferred) with automatic fallback
// to the v1 legacy API, then collects DNS, IPAM, and DHCP object counts
// to produce DDI Object token estimates.
package bluecat

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// supportedDNSRecordTypes is the set of DNS record types considered "supported"
// for Infoblox DDI token estimation.
var supportedDNSRecordTypes = map[string]struct{}{
	"A": {}, "AAAA": {}, "CNAME": {}, "MX": {}, "TXT": {},
	"CAA": {}, "SRV": {}, "SVCB": {}, "HTTPS": {}, "PTR": {},
	"NS": {}, "SOA": {}, "NAPTR": {},
}

// legacyTokenRE matches the "Session Token-> ... <-" format from legacy Bluecat v1 login.
var legacyTokenRE = regexp.MustCompile(`Session Token->\s*(?P<token>.+?)\s*<-`)

// retryStatuses are HTTP status codes that trigger automatic retry.
var retryStatuses = map[int]struct{}{
	429: {}, 500: {}, 502: {}, 503: {}, 504: {},
}

const (
	defaultPageSize   = 1000
	defaultMaxRetries = 3
	defaultBackoff    = 1.0 // seconds
	defaultTimeout    = 30  // seconds
)

// bluecatClient holds per-scan state (no state persists between scans).
type bluecatClient struct {
	baseURL          string
	username         string
	password         string
	httpClient       *http.Client
	apiMode          string // "v2" or "v1"
	authHeader       string
	maxRetries       int
	backoff          float64
	timeout          float64
	pageSize         int
	configurationIDs []string
}

// Scanner implements scanner.Scanner for Bluecat Address Manager.
type Scanner struct{}

// New returns a ready-to-use Bluecat Scanner.
func New() *Scanner { return &Scanner{} }

// doRequest performs an HTTP request with retry/backoff for 429/5xx.
func (c *bluecatClient) doRequest(method, path string, body io.Reader, headers map[string]string) (*http.Response, error) {
	reqURL := c.baseURL + path
	maxAttempts := c.maxRetries
	if maxAttempts < 1 {
		maxAttempts = 1
	}

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		req, err := http.NewRequest(method, reqURL, body)
		if err != nil {
			return nil, fmt.Errorf("creating request: %w", err)
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			if attempt == maxAttempts {
				return nil, fmt.Errorf("request %s %s failed after %d attempts: %w", method, path, maxAttempts, err)
			}
			time.Sleep(time.Duration(c.backoff*math.Pow(2, float64(attempt-1))) * time.Second)
			continue
		}

		if _, retry := retryStatuses[resp.StatusCode]; retry {
			resp.Body.Close()
			if attempt == maxAttempts {
				return nil, fmt.Errorf("request %s %s returned %d after %d attempts", method, path, resp.StatusCode, maxAttempts)
			}
			sleepSec := c.backoff * math.Pow(2, float64(attempt-1))
			if ra := resp.Header.Get("Retry-After"); ra != "" {
				var raSec int
				if _, err := fmt.Sscanf(ra, "%d", &raSec); err == nil && raSec > 0 {
					sleepSec = float64(raSec)
				}
			}
			time.Sleep(time.Duration(sleepSec) * time.Second)
			continue
		}

		return resp, nil
	}
	return nil, fmt.Errorf("request %s %s failed after retries", method, path)
}

// authHeaders returns standard headers including the auth header.
func (c *bluecatClient) authHeaders() map[string]string {
	h := map[string]string{"Accept": "application/json"}
	if c.authHeader != "" {
		h["Authorization"] = c.authHeader
	}
	return h
}

// authenticateV2 tries Bluecat API v2 session authentication.
func (s *Scanner) authenticateV2(c *bluecatClient) error {
	payload, _ := json.Marshal(map[string]string{
		"username": c.username,
		"password": c.password,
	})

	resp, err := c.doRequest("POST", "/api/v2/sessions", bytes.NewReader(payload), map[string]string{
		"Accept":       "application/json",
		"Content-Type": "application/json",
	})
	if err != nil {
		return fmt.Errorf("v2 auth request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("v2 auth returned HTTP %d", resp.StatusCode)
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("v2 auth decode: %w", err)
	}

	// Extract token: check access_token, apiToken, then basicAuthenticationCredentials
	token := extractStringField(result, "access_token", "apiToken", "token")
	tokenType := extractStringField(result, "tokenType")

	if basic, ok := result["basicAuthenticationCredentials"].(string); ok && basic != "" {
		c.authHeader = "Basic " + basic
		c.apiMode = "v2"
		return nil
	}

	if token == "" {
		return fmt.Errorf("v2 auth response missing token: %v", result)
	}

	if tokenType != "" {
		c.authHeader = tokenType + " " + token
	} else if strings.HasPrefix(token, "Bearer ") || strings.HasPrefix(token, "Basic ") {
		c.authHeader = token
	} else {
		c.authHeader = "Bearer " + token
	}
	c.apiMode = "v2"
	return nil
}

// authenticateV1 tries Bluecat API v1 legacy authentication.
func (s *Scanner) authenticateV1(c *bluecatClient) error {
	params := url.Values{}
	params.Set("username", c.username)
	params.Set("password", c.password)

	resp, err := c.doRequest("GET", "/Services/REST/v1/login?"+params.Encode(), nil, map[string]string{
		"Accept": "application/json",
	})
	if err != nil {
		return fmt.Errorf("v1 auth request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("v1 auth returned HTTP %d", resp.StatusCode)
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("v1 auth read body: %w", err)
	}
	bodyStr := string(bodyBytes)

	// Try JSON decode first
	var jsonResp map[string]interface{}
	if json.Unmarshal(bodyBytes, &jsonResp) == nil {
		if tok := extractStringField(jsonResp, "access_token", "apiToken", "token"); tok != "" {
			c.authHeader = "BAMAuthToken " + tok
			c.apiMode = "v1"
			return nil
		}
	}

	// Try legacy "Session Token-> ... <-" format
	if m := legacyTokenRE.FindStringSubmatch(bodyStr); len(m) > 1 {
		token := strings.TrimSpace(m[1])
		if token != "" {
			c.authHeader = "BAMAuthToken " + token
			c.apiMode = "v1"
			return nil
		}
	}

	// Use raw body as token
	token := strings.TrimSpace(bodyStr)
	if token == "" {
		return fmt.Errorf("v1 auth returned no usable token")
	}
	if strings.HasPrefix(token, "BAMAuthToken ") || strings.HasPrefix(token, "Bearer ") || strings.HasPrefix(token, "Basic ") {
		c.authHeader = token
	} else {
		c.authHeader = "BAMAuthToken " + token
	}
	c.apiMode = "v1"
	return nil
}

// authenticate tries v2 first, falls back to v1 on failure.
func (s *Scanner) authenticate(c *bluecatClient) error {
	if err := s.authenticateV2(c); err == nil {
		return nil
	}
	return s.authenticateV1(c)
}

// v2ResourceEndpoint is a single v2 API resource path and its item label.
type v2ResourceEndpoint struct {
	path  string // e.g. "/api/v2/views"
	label string // e.g. "BlueCat DNS Views"
}

// v1EntityType maps a v1 entity type name to the internal resource key.
type v1EntityType struct {
	entityType string // e.g. "View"
	label      string // e.g. "BlueCat DNS Views"
}

// countV2Endpoint paginates a v2 API endpoint, returning total count and raw items.
func (s *Scanner) countV2Endpoint(c *bluecatClient, path string) (int, []map[string]interface{}, error) {
	total := 0
	var allItems []map[string]interface{}
	offset := 0
	pageSize := c.pageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}

	for {
		qPath := fmt.Sprintf("%s?limit=%d&offset=%d", path, pageSize, offset)
		for _, cid := range c.configurationIDs {
			qPath += "&configurationId=" + url.QueryEscape(cid)
		}

		resp, err := c.doRequest("GET", qPath, nil, c.authHeaders())
		if err != nil {
			return total, allItems, err
		}

		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode >= 400 {
			return total, allItems, fmt.Errorf("v2 endpoint %s returned HTTP %d", path, resp.StatusCode)
		}

		var payload map[string]interface{}
		if err := json.Unmarshal(bodyBytes, &payload); err != nil {
			return total, allItems, fmt.Errorf("v2 endpoint %s decode: %w", path, err)
		}

		// Extract items from "data" key
		items := extractItems(payload, "data", "items", "result")
		total += len(items)
		allItems = append(allItems, items...)

		if len(items) == 0 {
			// Check for totalCount as authoritative count
			if tc, ok := asInt(payload["totalCount"]); ok && tc > 0 && total == 0 {
				total = tc
			}
			break
		}

		if len(items) < pageSize {
			break
		}
		offset += pageSize
	}
	return total, allItems, nil
}

// countV1Endpoint paginates a v1 API endpoint returning total count.
func (s *Scanner) countV1Endpoint(c *bluecatClient, entityType string) (int, error) {
	total := 0
	start := 0
	pageSize := c.pageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}

	for {
		qPath := fmt.Sprintf("/Services/REST/v1/getEntities?type=%s&start=%d&count=%d",
			url.QueryEscape(entityType), start, pageSize)

		resp, err := c.doRequest("GET", qPath, nil, c.authHeaders())
		if err != nil {
			return total, err
		}

		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode >= 400 {
			return total, fmt.Errorf("v1 getEntities type=%s returned HTTP %d", entityType, resp.StatusCode)
		}

		var items []interface{}
		if err := json.Unmarshal(bodyBytes, &items); err != nil {
			return total, fmt.Errorf("v1 getEntities type=%s decode: %w", entityType, err)
		}

		total += len(items)
		if len(items) < pageSize {
			break
		}
		start += pageSize
	}
	return total, nil
}

// makeFindingRow creates a FindingRow for Bluecat resources.
// All Bluecat resources map to DDI Objects category.
func makeFindingRow(item string, count int) calculator.FindingRow {
	return calculator.FindingRow{
		Provider:         "bluecat",
		Source:           "bluecat",
		Region:           "global",
		Category:         calculator.CategoryDDIObjects,
		Item:             item,
		Count:            count,
		TokensPerUnit:    calculator.TokensPerDDIObject,
		ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
	}
}

func ceilDiv(n, d int) int {
	if n <= 0 {
		return 0
	}
	return (n + d - 1) / d
}

// collectDNS collects DNS views, zones, and records (with supported/unsupported split).
func (s *Scanner) collectDNS(c *bluecatClient, publish func(scanner.Event)) []calculator.FindingRow {
	var rows []calculator.FindingRow

	type dnsResource struct {
		v2Path     string
		v1Type     string
		label      string
		getRecords bool // if true, collect raw items for type splitting
	}

	resources := []dnsResource{
		{"/api/v2/views", "View", "BlueCat DNS Views", false},
		{"/api/v2/zones", "Zone", "BlueCat DNS Zones", false},
		{"/api/v2/resourceRecords", "HostRecord", "", true},
	}

	for _, res := range resources {
		if res.getRecords {
			// DNS records need type-level splitting
			var supported, unsupported int
			if c.apiMode == "v2" {
				_, items, err := s.countV2Endpoint(c, res.v2Path)
				if err == nil {
					for _, item := range items {
						rtype := extractRecordType(item)
						if _, ok := supportedDNSRecordTypes[rtype]; ok {
							supported++
						} else {
							unsupported++
						}
					}
				}
			} else {
				// v1 fallback: count only (no type splitting available from getEntities)
				count, err := s.countV1Endpoint(c, res.v1Type)
				if err == nil {
					// v1 can't distinguish types; count all as supported
					supported = count
				}
			}
			rows = append(rows, makeFindingRow("BlueCat DNS Records (Supported Types)", supported))
			rows = append(rows, makeFindingRow("BlueCat DNS Records (Unsupported Types)", unsupported))
			publish(scanner.Event{
				Type:     "resource_progress",
				Provider: "bluecat",
				Resource: "dns_records",
				Count:    supported + unsupported,
				Status:   "done",
			})
			continue
		}

		var count int
		if c.apiMode == "v2" {
			cnt, _, err := s.countV2Endpoint(c, res.v2Path)
			if err == nil {
				count = cnt
			}
		} else {
			cnt, err := s.countV1Endpoint(c, res.v1Type)
			if err == nil {
				count = cnt
			}
		}
		rows = append(rows, makeFindingRow(res.label, count))
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: "bluecat",
			Resource: res.label,
			Count:    count,
			Status:   "done",
		})
	}
	return rows
}

// collectIPAMDHCP collects IPAM and DHCP resource counts.
func (s *Scanner) collectIPAMDHCP(c *bluecatClient, publish func(scanner.Event)) []calculator.FindingRow {
	type ipamResource struct {
		v2Path string
		v1Type string
		label  string
	}

	resources := []ipamResource{
		{"/api/v2/ip4blocks", "IP4Block", "BlueCat IP4 Blocks"},
		{"/api/v2/ip4networks", "IP4Network", "BlueCat IP4 Networks"},
		{"/api/v2/ip4addresses", "IP4Address", "BlueCat IP4 Addresses"},
		{"/api/v2/ip6blocks", "IP6Block", "BlueCat IP6 Blocks"},
		{"/api/v2/ip6networks", "IP6Network", "BlueCat IP6 Networks"},
		{"/api/v2/ip6addresses", "IP6Address", "BlueCat IP6 Addresses"},
		{"/api/v2/dhcp4ranges", "DHCP4Range", "BlueCat DHCP4 Ranges"},
		{"/api/v2/dhcp6ranges", "DHCP6Range", "BlueCat DHCP6 Ranges"},
	}

	var rows []calculator.FindingRow
	for _, res := range resources {
		var count int
		if c.apiMode == "v2" {
			cnt, _, err := s.countV2Endpoint(c, res.v2Path)
			if err == nil {
				count = cnt
			}
		} else {
			cnt, err := s.countV1Endpoint(c, res.v1Type)
			if err == nil {
				count = cnt
			}
		}
		rows = append(rows, makeFindingRow(res.label, count))
		publish(scanner.Event{
			Type:     "resource_progress",
			Provider: "bluecat",
			Resource: res.label,
			Count:    count,
			Status:   "done",
		})
	}
	return rows
}

// Scan implements scanner.Scanner.
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	_ = ctx // reserved for future cancellation support

	baseURL := strings.TrimRight(req.Credentials["bluecat_url"], "/")
	username := req.Credentials["bluecat_username"]
	password := req.Credentials["bluecat_password"]
	skipTLS := req.Credentials["skip_tls"] == "true"

	if baseURL == "" || username == "" || password == "" {
		return nil, fmt.Errorf("bluecat: missing required credentials (bluecat_url, bluecat_username, bluecat_password)")
	}

	// Parse configuration IDs
	var configIDs []string
	if cidStr := req.Credentials["configuration_ids"]; cidStr != "" {
		for _, id := range strings.Split(cidStr, ",") {
			id = strings.TrimSpace(id)
			if id != "" {
				configIDs = append(configIDs, id)
			}
		}
	}

	// Build per-scan HTTP client
	httpClient := &http.Client{
		Timeout: time.Duration(defaultTimeout) * time.Second,
	}
	if skipTLS {
		httpClient.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // user-requested skip
		}
	}

	c := &bluecatClient{
		baseURL:          baseURL,
		username:         username,
		password:         password,
		httpClient:       httpClient,
		maxRetries:       defaultMaxRetries,
		backoff:          defaultBackoff,
		timeout:          defaultTimeout,
		pageSize:         defaultPageSize,
		configurationIDs: configIDs,
	}

	// Authenticate (v2 preferred, v1 fallback)
	if err := s.authenticate(c); err != nil {
		return nil, fmt.Errorf("bluecat: authentication failed: %w", err)
	}

	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: "bluecat",
		Resource: "authentication",
		Status:   "done",
		Message:  fmt.Sprintf("Authenticated via API %s", c.apiMode),
	})

	// Collect resources
	var rows []calculator.FindingRow
	rows = append(rows, s.collectDNS(c, publish)...)
	rows = append(rows, s.collectIPAMDHCP(c, publish)...)

	publish(scanner.Event{
		Type:     "provider_complete",
		Provider: "bluecat",
		Status:   "done",
		Count:    len(rows),
	})

	return rows, nil
}

// ---------- helpers ----------

func extractStringField(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func extractItems(payload map[string]interface{}, keys ...string) []map[string]interface{} {
	for _, key := range keys {
		if arr, ok := payload[key].([]interface{}); ok {
			var items []map[string]interface{}
			for _, item := range arr {
				if m, ok := item.(map[string]interface{}); ok {
					items = append(items, m)
				}
			}
			return items
		}
	}
	return nil
}

func extractRecordType(item map[string]interface{}) string {
	for _, key := range []string{"type", "recordType", "rrtype", "record_type"} {
		if v, ok := item[key].(string); ok && v != "" {
			return strings.ToUpper(v)
		}
	}
	return ""
}

func asInt(v interface{}) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}
