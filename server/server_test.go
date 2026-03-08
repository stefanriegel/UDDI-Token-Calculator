package server_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/infoblox/uddi-go-token-calculator/server"
)

// fakeFS builds an in-memory FS that mimics what embed.FS looks like after fs.Sub.
// This lets us test static serving without requiring frontend/dist/ at test time.
func fakeFS() http.Handler {
	memFS := fstest.MapFS{
		"index.html":    {Data: []byte(`<!DOCTYPE html><html><head></head><body>DDI Scanner</body></html>`)},
		"assets/app.js": {Data: []byte(`console.log("app")`)},
	}
	return http.FileServer(http.FS(memFS))
}

func TestStaticServing(t *testing.T) {
	router := server.NewRouter(fakeFS())
	ts := httptest.NewServer(router)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatalf("GET /: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "<!DOCTYPE html") && !strings.Contains(string(body), "<html") {
		t.Errorf("expected HTML response, got: %s", body[:min(len(body), 200)])
	}
}

func TestStaticAssets(t *testing.T) {
	router := server.NewRouter(fakeFS())
	ts := httptest.NewServer(router)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/assets/app.js")
	if err != nil {
		t.Fatalf("GET /assets/app.js: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "javascript") {
		t.Errorf("expected Content-Type with javascript, got %q", ct)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
