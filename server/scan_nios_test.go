package server

import (
	"encoding/json"
	"testing"
)

// TestHandleScanResultsNIOS verifies the JSON shape of ScanResultsResponse when
// niosServerMetrics is populated. This test is skipped until Plan 04 adds the
// NiosServerMetric type and the niosServerMetrics field to ScanResultsResponse.
func TestHandleScanResultsNIOS(t *testing.T) {
	t.Skip("pending Plan 04 NiosServerMetric type")

	// Shape verification (executed once the skip is removed in Plan 04):
	// Build a JSON payload manually and assert round-trip correctness.
	payload := `{
		"scanId": "test-scan-1",
		"status": "complete",
		"completedAt": "2026-03-10T00:00:00Z",
		"totalManagementTokens": 42,
		"ddiTokens": 30,
		"ipTokens": 10,
		"assetTokens": 2,
		"findings": [],
		"errors": [],
		"niosServerMetrics": [
			{
				"memberId": "gm.test.local",
				"memberName": "gm.test.local",
				"role": "GM",
				"qps": 0,
				"lps": 0,
				"objectCount": 100
			}
		]
	}`

	var resp ScanResultsResponse
	if err := json.Unmarshal([]byte(payload), &resp); err != nil {
		t.Fatalf("json.Unmarshal failed: %v", err)
	}

	// Re-marshal and check key fields survive the round-trip.
	out, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("json.Marshal failed: %v", err)
	}

	var roundTripped map[string]interface{}
	if err := json.Unmarshal(out, &roundTripped); err != nil {
		t.Fatalf("round-trip json.Unmarshal failed: %v", err)
	}

	metrics, ok := roundTripped["niosServerMetrics"].([]interface{})
	if !ok || len(metrics) < 1 {
		t.Fatalf("niosServerMetrics missing or empty in round-tripped JSON")
	}

	first, ok := metrics[0].(map[string]interface{})
	if !ok {
		t.Fatalf("niosServerMetrics[0] is not an object")
	}

	for _, key := range []string{"memberId", "memberName", "role", "qps", "lps", "objectCount"} {
		if _, exists := first[key]; !exists {
			t.Errorf("niosServerMetrics[0] missing field %q", key)
		}
	}
}
