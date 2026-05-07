package bluecat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// ---------- helpers ----------

// fakeBluecatServer returns an httptest.Server that simulates Bluecat API responses.
// apiMode controls which auth endpoint succeeds: "v2", "v1", or "both".
func fakeBluecatServer(t *testing.T, apiMode string, resourceCounts map[string]int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// ----- v2 auth -----
		if path == "/api/v2/sessions" && r.Method == http.MethodPost {
			if apiMode == "v1" {
				http.Error(w, "v2 disabled", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"access_token": "test-bearer-token",
				"tokenType":    "Bearer",
			})
			return
		}

		// ----- v1 auth -----
		if path == "/Services/REST/v1/login" && r.Method == http.MethodGet {
			if apiMode == "v2" {
				http.Error(w, "v1 disabled", http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(w, `Session Token-> test-v1-token <-`)
			return
		}

		// ----- v2 resource endpoints -----
		v2Resources := map[string]string{
			"/api/v2/views":           "views",
			"/api/v2/zones":           "zones",
			"/api/v2/resourceRecords": "resourceRecords",
			"/api/v2/ip4blocks":       "ip4blocks",
			"/api/v2/ip4networks":     "ip4networks",
			"/api/v2/ip4addresses":    "ip4addresses",
			"/api/v2/ip6blocks":       "ip6blocks",
			"/api/v2/ip6networks":     "ip6networks",
			"/api/v2/ip6addresses":    "ip6addresses",
			"/api/v2/dhcp4ranges":     "dhcp4ranges",
			"/api/v2/dhcp6ranges":     "dhcp6ranges",
		}

		if resource, ok := v2Resources[path]; ok {
			count := resourceCounts[resource]
			offset := 0
			if q := r.URL.Query().Get("offset"); q != "" {
				fmt.Sscanf(q, "%d", &offset)
			}
			limit := 1000
			if q := r.URL.Query().Get("limit"); q != "" {
				fmt.Sscanf(q, "%d", &limit)
			}

			remaining := count - offset
			if remaining < 0 {
				remaining = 0
			}
			pageSize := remaining
			if pageSize > limit {
				pageSize = limit
			}

			var items []map[string]interface{}
			for i := 0; i < pageSize; i++ {
				item := map[string]interface{}{"id": offset + i}
				if resource == "resourceRecords" {
					// Alternate between supported and unsupported types
					if (offset+i)%2 == 0 {
						item["type"] = "A"
					} else {
						item["type"] = "UNKNOWNTYPE"
					}
				}
				items = append(items, item)
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"data":       items,
				"totalCount": count,
			})
			return
		}

		// ----- v1 resource endpoints (fallback) -----
		if path == "/Services/REST/v1/getEntities" {
			entityType := r.URL.Query().Get("type")
			v1TypeMap := map[string]string{
				"View":       "views",
				"Zone":       "zones",
				"HostRecord": "resourceRecords",
				"IP4Block":   "ip4blocks",
				"IP4Network": "ip4networks",
				"IP4Address": "ip4addresses",
				"IP6Block":   "ip6blocks",
				"IP6Network": "ip6networks",
				"IP6Address": "ip6addresses",
				"DHCP4Range": "dhcp4ranges",
				"DHCP6Range": "dhcp6ranges",
			}
			resource, ok := v1TypeMap[entityType]
			if !ok {
				w.Header().Set("Content-Type", "application/json")
				json.NewEncoder(w).Encode([]interface{}{})
				return
			}
			count := resourceCounts[resource]
			start := 0
			if q := r.URL.Query().Get("start"); q != "" {
				fmt.Sscanf(q, "%d", &start)
			}
			cnt := 1000
			if q := r.URL.Query().Get("count"); q != "" {
				fmt.Sscanf(q, "%d", &cnt)
			}

			remaining := count - start
			if remaining < 0 {
				remaining = 0
			}
			pageSize := remaining
			if pageSize > cnt {
				pageSize = cnt
			}

			var items []map[string]interface{}
			for i := 0; i < pageSize; i++ {
				items = append(items, map[string]interface{}{
					"id":   start + i,
					"type": entityType,
				})
			}

			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(items)
			return
		}

		http.NotFound(w, r)
	}))
}

func findRow(rows []calculator.FindingRow, item string) *calculator.FindingRow {
	for i := range rows {
		if rows[i].Item == item {
			return &rows[i]
		}
	}
	return nil
}

// ---------- auth tests ----------

func TestAuthenticateV2Success(t *testing.T) {
	srv := fakeBluecatServer(t, "v2", nil)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}
	err := s.authenticateV2(client)
	if err != nil {
		t.Fatalf("authenticateV2 should succeed: %v", err)
	}
	if client.apiMode != "v2" {
		t.Errorf("apiMode should be v2, got %q", client.apiMode)
	}
	if !strings.Contains(client.authHeader, "Bearer") {
		t.Errorf("authHeader should contain Bearer, got %q", client.authHeader)
	}
}

func TestAuthenticateV1Success(t *testing.T) {
	srv := fakeBluecatServer(t, "v1", nil)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}
	err := s.authenticateV1(client)
	if err != nil {
		t.Fatalf("authenticateV1 should succeed: %v", err)
	}
	if client.apiMode != "v1" {
		t.Errorf("apiMode should be v1, got %q", client.apiMode)
	}
	if !strings.Contains(client.authHeader, "BAMAuthToken") {
		t.Errorf("authHeader should contain BAMAuthToken, got %q", client.authHeader)
	}
}

func TestAuthenticateFallbackV2ToV1(t *testing.T) {
	// v2 auth endpoint returns 401, should fall back to v1
	srv := fakeBluecatServer(t, "v1", nil)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}
	err := s.authenticate(client)
	if err != nil {
		t.Fatalf("authenticate should succeed with v1 fallback: %v", err)
	}
	if client.apiMode != "v1" {
		t.Errorf("apiMode should be v1 after fallback, got %q", client.apiMode)
	}
}

func TestAuthenticateV2SkipsV1(t *testing.T) {
	// v2 auth succeeds, v1 should never be called
	srv := fakeBluecatServer(t, "v2", nil)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}
	err := s.authenticate(client)
	if err != nil {
		t.Fatalf("authenticate should succeed with v2: %v", err)
	}
	if client.apiMode != "v2" {
		t.Errorf("apiMode should be v2, got %q", client.apiMode)
	}
}

// ---------- v2 resource counting ----------

func TestV2DNSCounting(t *testing.T) {
	counts := map[string]int{
		"views":           3,
		"zones":           10,
		"resourceRecords": 100,
	}
	srv := fakeBluecatServer(t, "v2", counts)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		apiMode:    "v2",
		authHeader: "Bearer test-token",
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}

	rows := s.collectDNS(client, func(scanner.Event) {})
	viewRow := findRow(rows, "BlueCat DNS Views")
	if viewRow == nil || viewRow.Count != 3 {
		t.Errorf("expected 3 DNS views, got %v", viewRow)
	}
	zoneRow := findRow(rows, "BlueCat DNS Zones")
	if zoneRow == nil || zoneRow.Count != 10 {
		t.Errorf("expected 10 DNS zones, got %v", zoneRow)
	}
	// 100 records: 50 supported (even indices get "A"), 50 unsupported (odd indices get "UNKNOWNTYPE")
	supportedRow := findRow(rows, "BlueCat DNS Records (Supported Types)")
	if supportedRow == nil || supportedRow.Count != 50 {
		t.Errorf("expected 50 supported DNS records, got %v", supportedRow)
	}
	unsupportedRow := findRow(rows, "BlueCat DNS Records (Unsupported Types)")
	if unsupportedRow == nil || unsupportedRow.Count != 50 {
		t.Errorf("expected 50 unsupported DNS records, got %v", unsupportedRow)
	}
}

func TestV2IPAMCounting(t *testing.T) {
	counts := map[string]int{
		"ip4blocks":    5,
		"ip4networks":  20,
		"ip4addresses": 100,
		"ip6blocks":    2,
		"ip6networks":  8,
		"ip6addresses": 30,
	}
	srv := fakeBluecatServer(t, "v2", counts)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		apiMode:    "v2",
		authHeader: "Bearer test-token",
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}

	rows := s.collectIPAMDHCP(client, func(scanner.Event) {})

	expected := map[string]int{
		"BlueCat IP4 Blocks":    5,
		"BlueCat IP4 Networks":  20,
		"BlueCat IP4 Addresses": 100,
		"BlueCat IP6 Blocks":    2,
		"BlueCat IP6 Networks":  8,
		"BlueCat IP6 Addresses": 30,
	}
	for item, want := range expected {
		row := findRow(rows, item)
		if row == nil || row.Count != want {
			t.Errorf("%s: expected %d, got %v", item, want, row)
		}
	}
}

func TestV2DHCPCounting(t *testing.T) {
	counts := map[string]int{
		"dhcp4ranges": 15,
		"dhcp6ranges": 4,
	}
	srv := fakeBluecatServer(t, "v2", counts)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		apiMode:    "v2",
		authHeader: "Bearer test-token",
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}

	rows := s.collectIPAMDHCP(client, func(scanner.Event) {})

	dhcp4 := findRow(rows, "BlueCat DHCP4 Ranges")
	if dhcp4 == nil || dhcp4.Count != 15 {
		t.Errorf("expected 15 DHCP4 ranges, got %v", dhcp4)
	}
	dhcp6 := findRow(rows, "BlueCat DHCP6 Ranges")
	if dhcp6 == nil || dhcp6.Count != 4 {
		t.Errorf("expected 4 DHCP6 ranges, got %v", dhcp6)
	}
}

// ---------- v2 pagination ----------

func TestV2Pagination(t *testing.T) {
	// 2500 views with page size 1000 = 3 pages
	counts := map[string]int{
		"views": 2500,
	}
	srv := fakeBluecatServer(t, "v2", counts)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		apiMode:    "v2",
		authHeader: "Bearer test-token",
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}

	rows := s.collectDNS(client, func(scanner.Event) {})
	viewRow := findRow(rows, "BlueCat DNS Views")
	if viewRow == nil || viewRow.Count != 2500 {
		t.Errorf("expected 2500 DNS views via pagination, got %v", viewRow)
	}
}

// ---------- v1 fallback counting ----------

func TestV1FallbackCounting(t *testing.T) {
	counts := map[string]int{
		"views":           5,
		"zones":           15,
		"resourceRecords": 50,
		"ip4blocks":       3,
		"ip4networks":     10,
		"ip4addresses":    40,
		"ip6blocks":       1,
		"ip6networks":     4,
		"ip6addresses":    12,
		"dhcp4ranges":     7,
		"dhcp6ranges":     2,
	}
	srv := fakeBluecatServer(t, "v1", counts)
	defer srv.Close()

	s := New()
	client := &bluecatClient{
		baseURL:    srv.URL,
		username:   "admin",
		password:   "pass",
		httpClient: srv.Client(),
		apiMode:    "v1",
		authHeader: "BAMAuthToken test-v1-token",
		maxRetries: 1,
		backoff:    0,
		timeout:    5,
		pageSize:   1000,
	}

	dnsRows := s.collectDNS(client, func(scanner.Event) {})
	ipamRows := s.collectIPAMDHCP(client, func(scanner.Event) {})

	viewRow := findRow(dnsRows, "BlueCat DNS Views")
	if viewRow == nil || viewRow.Count != 5 {
		t.Errorf("v1: expected 5 views, got %v", viewRow)
	}
	zoneRow := findRow(dnsRows, "BlueCat DNS Zones")
	if zoneRow == nil || zoneRow.Count != 15 {
		t.Errorf("v1: expected 15 zones, got %v", zoneRow)
	}

	ip4Net := findRow(ipamRows, "BlueCat IP4 Networks")
	if ip4Net == nil || ip4Net.Count != 10 {
		t.Errorf("v1: expected 10 ip4networks, got %v", ip4Net)
	}
	dhcp4 := findRow(ipamRows, "BlueCat DHCP4 Ranges")
	if dhcp4 == nil || dhcp4.Count != 7 {
		t.Errorf("v1: expected 7 dhcp4ranges, got %v", dhcp4)
	}
}

// ---------- configuration ID filtering ----------

func TestConfigurationIDFiltering(t *testing.T) {
	var capturedConfigID atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/sessions" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"access_token": "tok",
				"tokenType":    "Bearer",
			})
			return
		}
		if r.URL.Path == "/api/v2/views" {
			if cid := r.URL.Query().Get("configurationId"); cid != "" {
				capturedConfigID.Store(cid)
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"data":       []interface{}{},
				"totalCount": 0,
			})
			return
		}
		// Handle other v2 endpoints with empty responses
		if strings.HasPrefix(r.URL.Path, "/api/v2/") {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"data":       []interface{}{},
				"totalCount": 0,
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "bluecat",
		Credentials: map[string]string{
			"bluecat_url":           srv.URL,
			"bluecat_username":      "admin",
			"bluecat_password":      "pass",
			"configuration_ids":     "42",
		},
	}
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan with configurationId should succeed: %v", err)
	}

	cid, ok := capturedConfigID.Load().(string)
	if !ok || cid != "42" {
		t.Errorf("expected configurationId=42 in query, got %q", cid)
	}
}

// ---------- skip TLS ----------

func TestSkipTLSCreatesIsolatedClient(t *testing.T) {
	srv := fakeBluecatServer(t, "v2", map[string]int{})
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "bluecat",
		Credentials: map[string]string{
			"bluecat_url":      srv.URL,
			"bluecat_username": "admin",
			"bluecat_password": "pass",
			"skip_tls":         "true",
		},
	}
	_, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan with skip_tls should succeed: %v", err)
	}
}

// ---------- full Scan integration ----------

func TestScanReturnsCorrectFindingRows(t *testing.T) {
	counts := map[string]int{
		"views":           3,
		"zones":           10,
		"resourceRecords": 20,
		"ip4blocks":       5,
		"ip4networks":     15,
		"ip4addresses":    50,
		"ip6blocks":       2,
		"ip6networks":     6,
		"ip6addresses":    18,
		"dhcp4ranges":     8,
		"dhcp6ranges":     3,
	}
	srv := fakeBluecatServer(t, "v2", counts)
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "bluecat",
		Credentials: map[string]string{
			"bluecat_url":      srv.URL,
			"bluecat_username": "admin",
			"bluecat_password": "pass",
		},
	}

	var events []scanner.Event
	rows, err := s.Scan(context.Background(), req, func(e scanner.Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Scan should succeed: %v", err)
	}

	// All rows should have Provider="bluecat"
	for _, row := range rows {
		if row.Provider != "bluecat" {
			t.Errorf("expected Provider=bluecat, got %q", row.Provider)
		}
	}

	// All rows should have Category="DDI Objects"
	for _, row := range rows {
		if row.Category != calculator.CategoryDDIObjects {
			t.Errorf("expected Category=%q, got %q for item %s", calculator.CategoryDDIObjects, row.Category, row.Item)
		}
	}

	// All rows should have TokensPerUnit=25
	for _, row := range rows {
		if row.TokensPerUnit != calculator.TokensPerDDIObject {
			t.Errorf("expected TokensPerUnit=%d, got %d for item %s", calculator.TokensPerDDIObject, row.TokensPerUnit, row.Item)
		}
	}

	// Check specific counts
	viewRow := findRow(rows, "BlueCat DNS Views")
	if viewRow == nil || viewRow.Count != 3 {
		t.Errorf("expected 3 DNS views, got %v", viewRow)
	}

	// 20 records: 10 supported (even "A"), 10 unsupported (odd "UNKNOWNTYPE")
	supportedRow := findRow(rows, "BlueCat DNS Records (Supported Types)")
	if supportedRow == nil || supportedRow.Count != 10 {
		t.Errorf("expected 10 supported DNS records, got %v", supportedRow)
	}

	// Verify progress events were published
	if len(events) == 0 {
		t.Error("expected progress events to be published")
	}

	// Should have rows for all 12 resource types (some may be 0)
	expectedItems := []string{
		"BlueCat DNS Views",
		"BlueCat DNS Zones",
		"BlueCat DNS Records (Supported Types)",
		"BlueCat DNS Records (Unsupported Types)",
		"BlueCat IP4 Blocks",
		"BlueCat IP4 Networks",
		"BlueCat IP4 Addresses",
		"BlueCat IP6 Blocks",
		"BlueCat IP6 Networks",
		"BlueCat IP6 Addresses",
		"BlueCat DHCP4 Ranges",
		"BlueCat DHCP6 Ranges",
	}
	for _, item := range expectedItems {
		if findRow(rows, item) == nil {
			t.Errorf("missing FindingRow for %q", item)
		}
	}
}
