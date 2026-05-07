package efficientip

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/sha3"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// --- siteWhereClause tests ---

func TestSiteWhereClause_NoSites(t *testing.T) {
	s := &Scanner{}
	got := s.siteWhereClause(nil)
	if got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestSiteWhereClause_SingleSite(t *testing.T) {
	s := &Scanner{}
	got := s.siteWhereClause([]string{"42"})
	want := "site_id='42'"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

func TestSiteWhereClause_MultipleSites(t *testing.T) {
	s := &Scanner{}
	got := s.siteWhereClause([]string{"1", "2", "3"})
	want := "(site_id='1' or site_id='2' or site_id='3')"
	if got != want {
		t.Fatalf("expected %q, got %q", want, got)
	}
}

// --- auth tests ---

func TestAuthenticate_BasicSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/member_list" {
			http.NotFound(w, r)
			return
		}
		user, pass, ok := r.BasicAuth()
		if ok && user == "admin" && pass == "secret" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	mode, err := s.authenticate(context.Background(), srv.URL, "credentials", "legacy", "admin", "secret", "", "", client)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != "basic" {
		t.Fatalf("expected basic, got %q", mode)
	}
}

func TestAuthenticate_NativeFallback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/member_list" {
			http.NotFound(w, r)
			return
		}
		// Reject Basic, accept native
		if r.Header.Get("X-IPM-Username") != "" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	mode, err := s.authenticate(context.Background(), srv.URL, "credentials", "legacy", "admin", "secret", "", "", client)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != "native" {
		t.Fatalf("expected native, got %q", mode)
	}
}

func TestAuthenticate_BothFail(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	_, err := s.authenticate(context.Background(), srv.URL, "credentials", "legacy", "admin", "wrong", "", "", client)
	if err == nil {
		t.Fatal("expected error when both auth modes fail")
	}
}

// --- token auth tests ---

func TestSetTokenAuth_SignatureFormat(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "https://host/rest/member_list?limit=1&offset=0", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	fullURL := req.URL.String()
	tokenID := "tid"
	tokenSecret := "sec"

	setTokenAuth(req, tokenID, tokenSecret, fullURL)

	authHeader := req.Header.Get("Authorization")
	tsHeader := req.Header.Get("X-SDS-TS")

	if !strings.HasPrefix(authHeader, "SDS tid:") {
		t.Fatalf("Authorization header does not start with 'SDS tid:': %q", authHeader)
	}
	if tsHeader == "" {
		t.Fatal("X-SDS-TS header is missing")
	}

	// Reconstruct expected signature from the captured timestamp
	ts, err := strconv.ParseInt(tsHeader, 10, 64)
	if err != nil {
		t.Fatalf("X-SDS-TS is not a valid integer: %q", tsHeader)
	}
	input := fmt.Sprintf("%s\n%d\n%s\n%s", tokenSecret, ts, http.MethodGet, fullURL)
	expected := sha3.Sum256([]byte(input))
	expectedHex := fmt.Sprintf("%x", expected)

	gotHex := strings.TrimPrefix(authHeader, "SDS tid:")
	if gotHex != expectedHex {
		t.Fatalf("SHA3-256 mismatch:\n  got:  %s\n  want: %s", gotHex, expectedHex)
	}
}

func TestBuildEndpointURL_Legacy(t *testing.T) {
	got := buildEndpointURL("https://host", "legacy", "dns_view_list")
	want := "https://host/rest/dns_view_list?"
	if got != want {
		t.Fatalf("legacy url: got %q, want %q", got, want)
	}
}

func TestBuildEndpointURL_V2(t *testing.T) {
	tests := []struct {
		service string
		want    string
	}{
		{"dns_view_list", "https://host/api/v2.0/dns/view/list?"},
		{"ip_site_list", "https://host/api/v2.0/ipam/space/list?"},
		{"dhcp_range6_list", "https://host/api/v2.0/dhcp/range6/list?"},
		{"member_list", "https://host/api/v2.0/app/node/list?"},
		{"ip_address_list", "https://host/api/v2.0/ipam/address/list?"},
		{"dhcp_scope_list", "https://host/api/v2.0/dhcp/scope/list?"},
	}
	for _, tt := range tests {
		got := buildEndpointURL("https://host", "v2", tt.service)
		if got != tt.want {
			t.Errorf("v2 service %q: got %q, want %q", tt.service, got, tt.want)
		}
	}
}

func TestAuthenticate_TokenSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		ts := r.Header.Get("X-SDS-TS")
		if strings.HasPrefix(auth, "SDS ") && ts != "" {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`[]`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	mode, err := s.authenticate(context.Background(), srv.URL, "token", "legacy", "", "", "tid", "sec", client)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if mode != "token" {
		t.Fatalf("expected token, got %q", mode)
	}
}

func TestAuthenticate_TokenFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	_, err := s.authenticate(context.Background(), srv.URL, "token", "legacy", "", "", "tid", "badsec", client)
	if err == nil {
		t.Fatal("expected error for token auth failure")
	}
}

// --- pagination test ---

func TestPagination(t *testing.T) {
	// Return 1000 items on page 0, 500 on page 1, then empty
	callCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		offset := r.URL.Query().Get("offset")
		var items []map[string]string
		switch offset {
		case "0":
			for i := 0; i < 1000; i++ {
				items = append(items, map[string]string{"id": fmt.Sprintf("%d", i)})
			}
		case "1000":
			for i := 0; i < 500; i++ {
				items = append(items, map[string]string{"id": fmt.Sprintf("%d", 1000+i)})
			}
		default:
			items = []map[string]string{}
		}
		callCount++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	count, _, err := s.countService(context.Background(), srv.URL, "basic", "legacy", "admin", "secret", "", "", client, "test_list", "", false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 1500 {
		t.Fatalf("expected 1500, got %d", count)
	}
}

// --- DNS counting with supported/unsupported split ---

func TestDNSCounting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(r.URL.Path, "dns_view_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "default"}})
		case strings.Contains(r.URL.Path, "dns_zone_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "example.com"}, {"name": "test.com"}})
		case strings.Contains(r.URL.Path, "dns_rr_list"):
			records := []map[string]string{
				{"rr_type": "A"},
				{"rr_type": "AAAA"},
				{"rr_type": "MX"},
				{"rr_type": "CUSTOM"},
				{"rr_type": "WEIRD"},
				{},
			}
			_ = json.NewEncoder(w).Encode(records)
		default:
			_ = json.NewEncoder(w).Encode([]map[string]string{})
		}
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	rows, err := s.collectDNS(context.Background(), srv.URL, "basic", "legacy", "admin", "secret", "", "", client, "", func(scanner.Event) {})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	found := map[string]int{}
	for _, r := range rows {
		found[r.Item] = r.Count
	}
	if found["EfficientIP DNS Views"] != 1 {
		t.Errorf("views: got %d, want 1", found["EfficientIP DNS Views"])
	}
	if found["EfficientIP DNS Zones"] != 2 {
		t.Errorf("zones: got %d, want 2", found["EfficientIP DNS Zones"])
	}
	if found["EfficientIP DNS Records (Supported Types)"] != 3 {
		t.Errorf("supported records: got %d, want 3", found["EfficientIP DNS Records (Supported Types)"])
	}
	if found["EfficientIP DNS Records (Unsupported Types)"] != 3 {
		t.Errorf("unsupported records: got %d, want 3", found["EfficientIP DNS Records (Unsupported Types)"])
	}
}

// --- IPAM + DHCP counting ---

func TestIPAMDHCPCounting(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		// Return 3 items for each endpoint
		items := []map[string]string{{"id": "1"}, {"id": "2"}, {"id": "3"}}
		switch {
		case strings.Contains(path, "ip_site_list"),
			strings.Contains(path, "ip_block_subnet_list") && !strings.Contains(path, "ip_subnet6"),
			strings.Contains(path, "ip_block_subnet6_list"),
			strings.Contains(path, "ip_pool_list") && !strings.Contains(path, "ip_pool6"),
			strings.Contains(path, "ip_pool6_list"),
			strings.Contains(path, "ip_address_list") && !strings.Contains(path, "ip_address6"),
			strings.Contains(path, "ip_address6_list"),
			strings.Contains(path, "dhcp_scope_list") && !strings.Contains(path, "dhcp_scope6"),
			strings.Contains(path, "dhcp_scope6_list"),
			strings.Contains(path, "dhcp_range_list") && !strings.Contains(path, "dhcp_range6"),
			strings.Contains(path, "dhcp_range6_list"):
			_ = json.NewEncoder(w).Encode(items)
		default:
			_ = json.NewEncoder(w).Encode([]map[string]string{})
		}
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	rows, err := s.collectIPAMDHCP(context.Background(), srv.URL, "basic", "legacy", "admin", "secret", "", "", client, "", func(scanner.Event) {})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	expectedItems := []string{
		"EfficientIP IP Sites",
		"EfficientIP IP4 Subnets", "EfficientIP IP6 Subnets",
		"EfficientIP IP4 Pools", "EfficientIP IP6 Pools",
		"EfficientIP IP4 Addresses", "EfficientIP IP6 Addresses",
		"EfficientIP DHCP4 Scopes", "EfficientIP DHCP6 Scopes",
		"EfficientIP DHCP4 Ranges", "EfficientIP DHCP6 Ranges",
	}
	found := map[string]int{}
	for _, r := range rows {
		found[r.Item] = r.Count
	}
	for _, item := range expectedItems {
		if found[item] != 3 {
			t.Errorf("%s: got %d, want 3", item, found[item])
		}
	}
}

// --- site filtering test ---

func TestSiteFiltering(t *testing.T) {
	var capturedWhere string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if where := r.URL.Query().Get("WHERE"); where != "" {
			capturedWhere = where
		}
		_ = json.NewEncoder(w).Encode([]map[string]string{})
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	whereClause := s.siteWhereClause([]string{"10", "20"})
	_, _, err := s.countService(context.Background(), srv.URL, "basic", "legacy", "admin", "secret", "", "", client, "ip_block_subnet_list", whereClause, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedWhere != "(site_id='10' or site_id='20')" {
		t.Fatalf("WHERE clause: got %q, want %q", capturedWhere, "(site_id='10' or site_id='20')")
	}
}

// --- skip TLS test ---

func TestSkipTLS(t *testing.T) {
	s := New()
	client := s.buildHTTPClient(true)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected *http.Transport")
	}
	if transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("expected InsecureSkipVerify=true")
	}
}

// --- full Scan integration test ---

func TestScan_FullIntegration(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case strings.Contains(path, "member_list"):
			// Auth probe succeeds with basic
			user, pass, ok := r.BasicAuth()
			if ok && user == "admin" && pass == "secret" {
				_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "node1"}})
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
		case strings.Contains(path, "dns_view_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "default"}, {"name": "internal"}})
		case strings.Contains(path, "dns_zone_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "example.com"}})
		case strings.Contains(path, "dns_rr_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"rr_type": "A"}, {"rr_type": "TXT"}, {"rr_type": "BOGUS"}})
		case strings.Contains(path, "ip_site_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"id": "1"}})
		case strings.Contains(path, "ip_block_subnet_list") && !strings.Contains(path, "ip_subnet6"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"id": "1"}, {"id": "2"}})
		case strings.Contains(path, "ip_block_subnet6_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"id": "1"}})
		default:
			_ = json.NewEncoder(w).Encode([]map[string]string{})
		}
	}))
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":      srv.URL,
			"efficientip_username": "admin",
			"efficientip_password": "secret",
		},
	}

	var events []scanner.Event
	rows, err := s.Scan(context.Background(), req, func(e scanner.Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	// Check provider and category on all rows
	for _, r := range rows {
		if r.Provider != "efficientip" {
			t.Errorf("provider: got %q, want efficientip", r.Provider)
		}
		if r.Category != calculator.CategoryDDIObjects {
			t.Errorf("category: got %q, want %q", r.Category, calculator.CategoryDDIObjects)
		}
		if r.TokensPerUnit != calculator.TokensPerDDIObject {
			t.Errorf("tokensPerUnit: got %d, want %d", r.TokensPerUnit, calculator.TokensPerDDIObject)
		}
	}

	// Verify specific counts
	found := map[string]int{}
	for _, r := range rows {
		found[r.Item] = r.Count
	}
	if found["EfficientIP DNS Views"] != 2 {
		t.Errorf("views: got %d, want 2", found["EfficientIP DNS Views"])
	}
	if found["EfficientIP DNS Zones"] != 1 {
		t.Errorf("zones: got %d, want 1", found["EfficientIP DNS Zones"])
	}
	if found["EfficientIP DNS Records (Supported Types)"] != 2 {
		t.Errorf("supported: got %d, want 2", found["EfficientIP DNS Records (Supported Types)"])
	}
	if found["EfficientIP DNS Records (Unsupported Types)"] != 1 {
		t.Errorf("unsupported: got %d, want 1", found["EfficientIP DNS Records (Unsupported Types)"])
	}
	if found["EfficientIP IP Sites"] != 1 {
		t.Errorf("sites: got %d, want 1", found["EfficientIP IP Sites"])
	}
	if found["EfficientIP IP4 Subnets"] != 2 {
		t.Errorf("subnets: got %d, want 2", found["EfficientIP IP4 Subnets"])
	}

	// Verify events were published
	if len(events) == 0 {
		t.Error("expected progress events, got none")
	}
}

// --- FindingRow mapping correctness ---

func TestFindingRowMapping(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path
		switch {
		case strings.Contains(path, "member_list"):
			user, _, ok := r.BasicAuth()
			if ok && user == "admin" {
				_ = json.NewEncoder(w).Encode([]map[string]string{})
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
		case strings.Contains(path, "dns_view_list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "v1"}})
		default:
			_ = json.NewEncoder(w).Encode([]map[string]string{})
		}
	}))
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":      srv.URL,
			"efficientip_username": "admin",
			"efficientip_password": "secret",
		},
	}

	rows, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	// All rows should have Source="efficientip" and Region=""
	for _, r := range rows {
		if r.Source != "efficientip" {
			t.Errorf("source: got %q, want efficientip", r.Source)
		}
		if r.Region != "" {
			t.Errorf("region: got %q, want empty", r.Region)
		}
	}
}

// --- TestScan_TokenAuth: full Scan with token auth ---

func TestScan_TokenAuth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// All endpoints require SDS token auth
		auth := r.Header.Get("Authorization")
		ts := r.Header.Get("X-SDS-TS")
		if !strings.HasPrefix(auth, "SDS tid:") || ts == "" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		path := r.URL.Path
		switch {
		case strings.Contains(path, "member_list") || strings.Contains(path, "node/list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "node1"}})
		case strings.Contains(path, "dns_view_list") || strings.Contains(path, "dns/view/list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "default"}})
		case strings.Contains(path, "dns_zone_list") || strings.Contains(path, "dns/zone/list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"name": "example.com"}})
		case strings.Contains(path, "dns_rr_list") || strings.Contains(path, "dns/rr/list"):
			_ = json.NewEncoder(w).Encode([]map[string]string{{"rr_type": "A"}, {"rr_type": "AAAA"}})
		default:
			_ = json.NewEncoder(w).Encode([]map[string]string{})
		}
	}))
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":         srv.URL,
			"efficientip_auth_method": "token",
			"efficientip_token_id":    "tid",
			"efficientip_token_secret": "sec",
		},
	}

	rows, err := s.Scan(context.Background(), req, func(scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan with token auth failed: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("expected non-empty rows from token auth scan")
	}
	// Verify DNS views row is present
	found := map[string]int{}
	for _, r := range rows {
		found[r.Item] = r.Count
	}
	if found["EfficientIP DNS Views"] != 1 {
		t.Errorf("views: got %d, want 1", found["EfficientIP DNS Views"])
	}
}

// --- New tests: Endpoint Alignment + Response Parsing (S02/T01) ---

// TestBuildEndpointURL_V2_IPAMPaths verifies the three corrected IPAM path entries.
func TestBuildEndpointURL_V2_IPAMPaths(t *testing.T) {
	cases := []struct {
		service  string
		wantSuffix string
	}{
		{"ip_site_list", "ipam/space/list"},
		{"ip_block_subnet_list", "ipam/network/list"},
		{"ip_block_subnet6_list", "ipam/network6/list"},
	}
	for _, tc := range cases {
		got := buildEndpointURL("https://host", "v2", tc.service)
		if !strings.Contains(got, tc.wantSuffix) {
			t.Errorf("service %q: got %q, want it to contain %q", tc.service, got, tc.wantSuffix)
		}
	}
}

// TestCountService_V2ResponseWrapper verifies that countService correctly unwraps
// the v2.0 response envelope {"success":true,"data":[...]} and counts elements.
func TestCountService_V2ResponseWrapper(t *testing.T) {
	pageOnce := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		offset := r.URL.Query().Get("offset")
		if offset == "" || offset == "0" {
			if !pageOnce {
				pageOnce = true
				// First page: 3 items wrapped in v2.0 envelope
				_, _ = w.Write([]byte(`{"success":true,"data":[{"id":"1"},{"id":"2"},{"id":"3"}]}`))
				return
			}
		}
		// Subsequent pages: empty v2.0 envelope
		_, _ = w.Write([]byte(`{"success":true,"data":[]}`))
	}))
	defer srv.Close()

	s := New()
	client := srv.Client()
	count, _, err := s.countService(
		context.Background(),
		srv.URL, "basic", "v2", "admin", "secret", "", "",
		client,
		"dns_rr_list", "", false,
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if count != 3 {
		t.Fatalf("expected count 3, got %d", count)
	}
}

// TestSplitDNSRecords_RrTypeField verifies that rr_type is the primary key used
// for DNS record type classification, with "type" as a fallback.
func TestSplitDNSRecords_RrTypeField(t *testing.T) {
	records := []map[string]interface{}{
		// rr_type wins over type
		{"rr_type": "A", "type": "CNAME"},
		// fallback to type when rr_type absent
		{"type": "MX"},
		// unsupported type is excluded from supported count
		{"rr_type": "UNKNOWN_TYPE"},
		// record with no type fields
		{},
	}

	supported, unsupported := splitDNSRecords(records)

	// Record 0: rr_type="A" → supported (would be CNAME if type was used, also supported)
	// We verify rr_type is primary by using a case where only rr_type produces the expected split.
	// Record 1: type="MX" → supported
	// Record 2: rr_type="UNKNOWN_TYPE" → unsupported
	// Record 3: no type → unsupported
	if supported != 2 {
		t.Errorf("supported: got %d, want 2", supported)
	}
	if unsupported != 2 {
		t.Errorf("unsupported: got %d, want 2", unsupported)
	}

	// Confirm rr_type is primary: a record with rr_type="BOGUS" and type="A"
	// should be unsupported (rr_type wins).
	records2 := []map[string]interface{}{
		{"rr_type": "BOGUS", "type": "A"},
	}
	sup2, unsup2 := splitDNSRecords(records2)
	if sup2 != 0 || unsup2 != 1 {
		t.Errorf("rr_type priority: expected 0 supported / 1 unsupported, got %d/%d", sup2, unsup2)
	}
}

// TestScan_V2WrappedResponses runs a full Scan() against a mock server that
// returns v2.0 wrapped responses ({"success":true,"data":[...]}) for all endpoints.
func TestScan_V2WrappedResponses(t *testing.T) {
	wrap := func(items string) string {
		return `{"success":true,"data":` + items + `}`
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path

		// Auth probe uses /api/v2.0/app/node/list for v2 mode.
		// Accept basic auth for the probe.
		if strings.Contains(path, "app/node/list") || strings.Contains(path, "member_list") {
			user, pass, ok := r.BasicAuth()
			if ok && user == "admin" && pass == "secret" {
				_, _ = w.Write([]byte(wrap(`[{"name":"node1"}]`)))
				return
			}
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		switch {
		case strings.Contains(path, "dns/view/list") || strings.Contains(path, "dns_view_list"):
			_, _ = w.Write([]byte(wrap(`[{"name":"default"},{"name":"internal"}]`)))
		case strings.Contains(path, "dns/zone/list") || strings.Contains(path, "dns_zone_list"):
			_, _ = w.Write([]byte(wrap(`[{"name":"example.com"},{"name":"test.com"}]`)))
		case strings.Contains(path, "dns/rr/list") || strings.Contains(path, "dns_rr_list"):
			_, _ = w.Write([]byte(wrap(`[{"rr_type":"A"},{"rr_type":"AAAA"},{"rr_type":"MX"},{"rr_type":"BOGUS"}]`)))
		case strings.Contains(path, "ipam/space/list"):
			_, _ = w.Write([]byte(wrap(`[{"id":"1"},{"id":"2"}]`)))
		case strings.Contains(path, "ipam/network/list") && !strings.Contains(path, "network6"):
			_, _ = w.Write([]byte(wrap(`[{"id":"1"},{"id":"2"},{"id":"3"}]`)))
		case strings.Contains(path, "ipam/network6/list"):
			_, _ = w.Write([]byte(wrap(`[{"id":"1"}]`)))
		default:
			_, _ = w.Write([]byte(wrap(`[]`)))
		}
	}))
	defer srv.Close()

	s := New()
	req := scanner.ScanRequest{
		Provider: "efficientip",
		Credentials: map[string]string{
			"efficientip_url":             srv.URL,
			"efficientip_username":        "admin",
			"efficientip_password":        "secret",
			"efficientip_api_version":     "v2",
			"efficientip_auth_method":     "credentials",
		},
	}

	var events []scanner.Event
	rows, err := s.Scan(context.Background(), req, func(e scanner.Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Scan with v2 wrapped responses failed: %v", err)
	}
	if len(rows) == 0 {
		t.Fatal("expected non-empty FindingRow results from v2 Scan")
	}

	found := map[string]int{}
	for _, r := range rows {
		found[r.Item] = r.Count
	}

	// DNS records should be present with correct split
	if found["EfficientIP DNS Records (Supported Types)"] == 0 {
		t.Errorf("expected non-zero supported DNS records, got 0; all rows: %+v", found)
	}
	// 3 supported (A, AAAA, MX) + 1 unsupported (BOGUS)
	if found["EfficientIP DNS Records (Supported Types)"] != 3 {
		t.Errorf("supported DNS records: got %d, want 3", found["EfficientIP DNS Records (Supported Types)"])
	}
	if found["EfficientIP DNS Records (Unsupported Types)"] != 1 {
		t.Errorf("unsupported DNS records: got %d, want 1", found["EfficientIP DNS Records (Unsupported Types)"])
	}

	// IPAM: spaces/networks correctly routed to corrected v2 paths
	if found["EfficientIP IP Sites"] != 2 {
		t.Errorf("IP Sites: got %d, want 2", found["EfficientIP IP Sites"])
	}
	if found["EfficientIP IP4 Subnets"] != 3 {
		t.Errorf("IP4 Subnets: got %d, want 3", found["EfficientIP IP4 Subnets"])
	}
	if found["EfficientIP IP6 Subnets"] != 1 {
		t.Errorf("IP6 Subnets: got %d, want 1", found["EfficientIP IP6 Subnets"])
	}

	// Verify events were published
	if len(events) == 0 {
		t.Error("expected progress events, got none")
	}
}

