package nios

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// ---------------------------------------------------------------------------
// resolveVersion tests
// ---------------------------------------------------------------------------

func TestWAPI_ResolveVersion_Explicit(t *testing.T) {
	// When explicit version is set, it should be returned immediately without HTTP calls.
	ws := &WAPIScanner{explicitVersion: "2.12.3"}
	ver, err := ws.resolveVersion(nil) // nil client = must not make HTTP calls
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ver != "2.12.3" {
		t.Errorf("expected 2.12.3, got %s", ver)
	}
}

func TestWAPI_ResolveVersion_Embedded(t *testing.T) {
	// When base URL contains /wapi/v2.11.1, extract embedded version.
	ws := &WAPIScanner{baseURL: "https://gm.example.com/wapi/v2.11.1/capacityreport"}
	ver, err := ws.resolveVersion(nil) // nil client ok if no HTTP needed
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ver != "2.11.1" {
		t.Errorf("expected 2.11.1, got %s", ver)
	}
}

func TestWAPI_ResolveVersion_Wapidoc(t *testing.T) {
	// Serve a wapidoc HTML page with version links.
	mux := http.NewServeMux()
	mux.HandleFunc("/wapidoc/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><body>
			<a href="/wapidoc/v2.12/">v2.12</a>
			<a href="/wapidoc/v2.11.2/">v2.11.2</a>
			<a href="/wapidoc/v2.10.5/">v2.10.5</a>
		</body></html>`)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	ws := &WAPIScanner{baseURL: ts.URL}
	ver, err := ws.resolveVersion(ts.Client())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ver != "2.12" {
		t.Errorf("expected 2.12 (highest), got %s", ver)
	}
}

func TestWAPI_ResolveVersion_ProbeCandidates(t *testing.T) {
	// Wapidoc returns 404, probe candidates until one returns 200.
	calls := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/wapidoc/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/wapi/", func(w http.ResponseWriter, r *http.Request) {
		calls++
		// Accept version 2.12.3 (third in probe list based on Python ref).
		if strings.Contains(r.URL.Path, "/v2.12.3/") {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, `[{"_ref":"grid/b25l:"}]`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	ws := &WAPIScanner{baseURL: ts.URL}
	ver, err := ws.resolveVersion(ts.Client())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ver != "2.12.3" {
		t.Errorf("expected 2.12.3, got %s", ver)
	}
	// Should have probed versions before 2.12.3 first.
	if calls < 2 {
		t.Errorf("expected at least 2 probe calls, got %d", calls)
	}
}

func TestWAPI_ResolveVersion_AuthError(t *testing.T) {
	// 401 during probe should return auth error immediately, not continue probing.
	mux := http.NewServeMux()
	mux.HandleFunc("/wapidoc/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/wapi/", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	ws := &WAPIScanner{baseURL: ts.URL}
	_, err := ws.resolveVersion(ts.Client())
	if err == nil {
		t.Fatal("expected auth error, got nil")
	}
	if !strings.Contains(err.Error(), "authentication") && !strings.Contains(err.Error(), "401") {
		t.Errorf("expected auth-related error, got: %v", err)
	}
}

// ---------------------------------------------------------------------------
// classifyMetric tests
// ---------------------------------------------------------------------------

func TestWAPI_ClassifyMetric(t *testing.T) {
	tests := []struct {
		typeName string
		wantCat  string // expected category or "" if uncategorized
		wantItem string // expected item name substring
	}{
		{"DNS Views", calculator.CategoryDDIObjects, "DNS Views"},
		{"DNS Zones", calculator.CategoryDDIObjects, "DNS Zones"},
		{"DNS A Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS AAAA Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS CNAME Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS MX Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS TXT Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS CAA Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS SRV Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS SVCB Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS HTTPS Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS PTR Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS NS Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS SOA Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS NAPTR Records", calculator.CategoryDDIObjects, "Supported"},
		{"DNS Records (Unsupported Types)", calculator.CategoryDDIObjects, "Unsupported"},
		{"IPv4 Blocks", calculator.CategoryDDIObjects, "IPv4 Blocks"},
		{"IPv4 Networks", calculator.CategoryDDIObjects, "IPv4 Networks"},
		{"IPv4 Addresses", calculator.CategoryDDIObjects, "IPv4 Addresses"},
		{"IPv6 Blocks", calculator.CategoryDDIObjects, "IPv6 Blocks"},
		{"IPv6 Networks", calculator.CategoryDDIObjects, "IPv6 Networks"},
		{"IPv6 Addresses", calculator.CategoryDDIObjects, "IPv6 Addresses"},
		{"DHCPv4 Leases", calculator.CategoryActiveIPs, "DHCPv4 Leases"},
		{"DHCPv6 Leases", calculator.CategoryActiveIPs, "DHCPv6 Leases"},
	}

	for _, tt := range tests {
		t.Run(tt.typeName, func(t *testing.T) {
			row := classifyMetric(tt.typeName, 42)
			if row == nil {
				t.Fatalf("expected a FindingRow for %q, got nil", tt.typeName)
			}
			if row.Category != tt.wantCat {
				t.Errorf("category: got %q, want %q", row.Category, tt.wantCat)
			}
			if !strings.Contains(row.Item, tt.wantItem) {
				t.Errorf("item: got %q, want it to contain %q", row.Item, tt.wantItem)
			}
			if row.Count != 42 {
				t.Errorf("count: got %d, want 42", row.Count)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// iterObjectCounts tests
// ---------------------------------------------------------------------------

func TestWAPI_IterObjectCounts_ListOfDicts(t *testing.T) {
	raw := json.RawMessage(`[
		{"type_name": "DNS Zones", "count": 10},
		{"type_name": "IPv4 Networks", "count": 5}
	]`)
	counts := iterObjectCounts(raw)
	if len(counts) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(counts))
	}
	if counts[0].typeName != "DNS Zones" || counts[0].count != 10 {
		t.Errorf("entry 0: got %+v", counts[0])
	}
}

func TestWAPI_IterObjectCounts_DictFormat(t *testing.T) {
	raw := json.RawMessage(`{"DNS Zones": 10, "IPv4 Networks": 5}`)
	counts := iterObjectCounts(raw)
	if len(counts) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(counts))
	}
	// Check both entries exist (order may vary for dict)
	found := map[string]int{}
	for _, c := range counts {
		found[c.typeName] = c.count
	}
	if found["DNS Zones"] != 10 {
		t.Errorf("DNS Zones: got %d, want 10", found["DNS Zones"])
	}
	if found["IPv4 Networks"] != 5 {
		t.Errorf("IPv4 Networks: got %d, want 5", found["IPv4 Networks"])
	}
}

// ---------------------------------------------------------------------------
// Full Scan integration test with mock HTTP server
// ---------------------------------------------------------------------------

func TestWAPI_Scan_Integration(t *testing.T) {
	// Mock a NIOS Grid Manager returning capacityreport with two members.
	capacityReport := `[
		{
			"name": "gm.example.com",
			"hardware_type": "IB-V4025",
			"role": "Grid Master",
			"total_objects": 500,
			"object_counts": [
				{"type_name": "DNS Zones", "count": 100},
				{"type_name": "DNS A Records", "count": 200},
				{"type_name": "IPv4 Networks", "count": 50},
				{"type_name": "DHCPv4 Leases", "count": 1000}
			]
		},
		{
			"name": "member1.example.com",
			"hardware_type": "IB-V2215",
			"role": "Grid Member",
			"total_objects": 100,
			"object_counts": [
				{"type_name": "DNS Zones", "count": 20},
				{"type_name": "DHCPv4 Leases", "count": 300}
			]
		}
	]`

	mux := http.NewServeMux()
	mux.HandleFunc("/wapi/v2.13.7/capacityreport", func(w http.ResponseWriter, r *http.Request) {
		// Verify basic auth is set.
		user, pass, ok := r.BasicAuth()
		if !ok || user != "admin" || pass != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, capacityReport)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	ws := NewWAPI()
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"wapi_url":      ts.URL,
			"wapi_username": "admin",
			"wapi_password": "secret",
			"wapi_version":  "2.13.7",
		},
	}

	var events []scanner.Event
	rows, err := ws.Scan(context.Background(), req, func(e scanner.Event) {
		events = append(events, e)
	})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	if len(rows) == 0 {
		t.Fatal("expected FindingRows, got none")
	}

	// Check we have both DDI Objects and Active IPs categories.
	hasDDI := false
	hasIP := false
	for _, r := range rows {
		if r.Provider != "nios" {
			t.Errorf("expected provider nios, got %s", r.Provider)
		}
		if r.Category == calculator.CategoryDDIObjects {
			hasDDI = true
		}
		if r.Category == calculator.CategoryActiveIPs {
			hasIP = true
		}
		if r.TokensPerUnit == 0 {
			t.Errorf("FindingRow %q has zero TokensPerUnit", r.Item)
		}
		if r.ManagementTokens == 0 && r.Count > 0 {
			t.Errorf("FindingRow %q has Count=%d but ManagementTokens=0", r.Item, r.Count)
		}
	}
	if !hasDDI {
		t.Error("no DDI Objects category found in results")
	}
	if !hasIP {
		t.Error("no Active IPs category found in results")
	}

	// Both members should appear as sources.
	sources := map[string]bool{}
	for _, r := range rows {
		sources[r.Source] = true
	}
	if !sources["gm.example.com"] {
		t.Error("gm.example.com not in sources")
	}
	if !sources["member1.example.com"] {
		t.Error("member1.example.com not in sources")
	}
}

// ---------------------------------------------------------------------------
// GetNiosServerMetricsJSON tests
// ---------------------------------------------------------------------------

func TestWAPI_GetNiosServerMetricsJSON(t *testing.T) {
	// Run a scan and then check the JSON output.
	capacityReport := `[
		{
			"name": "gm.example.com",
			"role": "Grid Master",
			"total_objects": 500,
			"object_counts": [
				{"type_name": "DNS Zones", "count": 100}
			]
		}
	]`

	mux := http.NewServeMux()
	mux.HandleFunc("/wapi/v2.13.7/capacityreport", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, capacityReport)
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	ws := NewWAPI()
	req := scanner.ScanRequest{
		Provider: "nios",
		Credentials: map[string]string{
			"wapi_url":      ts.URL,
			"wapi_username": "admin",
			"wapi_password": "secret",
			"wapi_version":  "2.13.7",
		},
	}
	_, err := ws.Scan(context.Background(), req, func(e scanner.Event) {})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}

	metricsJSON := ws.GetNiosServerMetricsJSON()
	if metricsJSON == nil {
		t.Fatal("GetNiosServerMetricsJSON returned nil")
	}

	var metrics []NiosServerMetric
	if err := json.Unmarshal(metricsJSON, &metrics); err != nil {
		t.Fatalf("failed to unmarshal metrics: %v", err)
	}

	if len(metrics) == 0 {
		t.Fatal("expected at least one metric")
	}
	m := metrics[0]
	if m.MemberName != "gm.example.com" {
		t.Errorf("expected gm.example.com, got %s", m.MemberName)
	}
	if m.ObjectCount != 500 {
		t.Errorf("expected objectCount 500 from total_objects, got %d", m.ObjectCount)
	}
	if m.QPS != 0 || m.LPS != 0 {
		t.Errorf("expected QPS=0, LPS=0, got QPS=%d, LPS=%d", m.QPS, m.LPS)
	}
}

// ---------------------------------------------------------------------------
// TLS skip-verify: ensure per-scanner client, not DefaultTransport mutation
// ---------------------------------------------------------------------------

func TestWAPI_TLSSkipVerify_NoDefaultTransportMutation(t *testing.T) {
	// Capture DefaultTransport's TLS config before creating scanner.
	defaultTransport := http.DefaultTransport.(*http.Transport)
	tlsBefore := defaultTransport.TLSClientConfig

	ws := NewWAPI()
	client := ws.makeHTTPClient(true)

	// After creating a skip-verify client, DefaultTransport must be unchanged.
	tlsAfter := defaultTransport.TLSClientConfig
	if tlsBefore != tlsAfter {
		t.Error("makeHTTPClient modified http.DefaultTransport.TLSClientConfig")
	}

	// The returned client should have InsecureSkipVerify set.
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatal("expected *http.Transport")
	}
	if transport.TLSClientConfig == nil || !transport.TLSClientConfig.InsecureSkipVerify {
		t.Error("expected InsecureSkipVerify=true on scanner client")
	}
}
