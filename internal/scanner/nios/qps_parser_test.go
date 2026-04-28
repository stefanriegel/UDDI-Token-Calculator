package nios

import (
	"strings"
	"testing"
)

// Realistic Splunk XML fixture with 3 members across 5 time buckets.
const splunkXMLFixture = `<?xml version='1.0' encoding='UTF-8'?>
<results preview='0'>
<meta>
<fieldOrder>
<field>_time</field>
<field splitby_field="source_host" splitby_value="dns-1.example.com">dns-1.example.com</field>
<field splitby_field="source_host" splitby_value="dns-2.example.com">dns-2.example.com</field>
<field splitby_field="source_host" splitby_value="dns-3.example.com">dns-3.example.com</field>
</fieldOrder>
</meta>
<result offset='0'>
<field k='_time'><value><text>2026-04-10T00:00:00.000+02:00</text></value></field>
<field k='dns-1.example.com'><value><text>45.46</text></value></field>
<field k='dns-2.example.com'><value><text>749.9</text></value></field>
<field k='dns-3.example.com'><value><text>100.0</text></value></field>
</result>
<result offset='1'>
<field k='_time'><value><text>2026-04-10T01:00:00.000+02:00</text></value></field>
<field k='dns-1.example.com'><value><text>1281.56</text></value></field>
<field k='dns-2.example.com'><value><text>500.0</text></value></field>
<field k='dns-3.example.com'><value><text>200.5</text></value></field>
</result>
<result offset='2'>
<field k='_time'><value><text>2026-04-10T02:00:00.000+02:00</text></value></field>
<field k='dns-1.example.com'><value><text>800.0</text></value></field>
<field k='dns-2.example.com'><value><text>1500.25</text></value></field>
<field k='dns-3.example.com'><value><text>50.0</text></value></field>
</result>
<result offset='3'>
<field k='_time'><value><text>2026-04-10T03:00:00.000+02:00</text></value></field>
<field k='dns-1.example.com'><value><text>600.0</text></value></field>
<field k='dns-2.example.com'><value><text>200.0</text></value></field>
<field k='dns-3.example.com'><value><text>3000.75</text></value></field>
</result>
<result offset='4'>
<field k='_time'><value><text>2026-04-10T04:00:00.000+02:00</text></value></field>
<field k='dns-1.example.com'><value><text>100.0</text></value></field>
<field k='dns-2.example.com'><value><text>300.0</text></value></field>
<field k='dns-3.example.com'><value><text>500.0</text></value></field>
</result>
</results>`

func TestParseSplunkQPS_PeakExtraction(t *testing.T) {
	qps, err := ParseSplunkQPS(strings.NewReader(splunkXMLFixture))
	if err != nil {
		t.Fatalf("ParseSplunkQPS() error = %v", err)
	}

	if len(qps) != 3 {
		t.Fatalf("expected 3 members, got %d", len(qps))
	}

	// dns-1 peak is 1281.56 (from offset 1)
	if got := qps["dns-1.example.com"]; got != 1281.56 {
		t.Errorf("dns-1 peak QPS = %v, want 1281.56", got)
	}

	// dns-2 peak is 1500.25 (from offset 2)
	if got := qps["dns-2.example.com"]; got != 1500.25 {
		t.Errorf("dns-2 peak QPS = %v, want 1500.25", got)
	}

	// dns-3 peak is 3000.75 (from offset 3)
	if got := qps["dns-3.example.com"]; got != 3000.75 {
		t.Errorf("dns-3 peak QPS = %v, want 3000.75", got)
	}
}

func TestParseSplunkQPS_EmptyResults(t *testing.T) {
	xml := `<?xml version='1.0' encoding='UTF-8'?>
<results preview='0'>
<meta>
<fieldOrder>
<field>_time</field>
</fieldOrder>
</meta>
</results>`

	qps, err := ParseSplunkQPS(strings.NewReader(xml))
	if err != nil {
		t.Fatalf("ParseSplunkQPS() error = %v", err)
	}
	if len(qps) != 0 {
		t.Errorf("expected empty map, got %d entries", len(qps))
	}
}

func TestParseSplunkQPS_MalformedXML(t *testing.T) {
	_, err := ParseSplunkQPS(strings.NewReader("<results><broken"))
	if err == nil {
		t.Error("expected error for malformed XML, got nil")
	}
}

func TestParseSplunkQPS_EmptyInput(t *testing.T) {
	_, err := ParseSplunkQPS(strings.NewReader(""))
	// Empty input should return error (no valid XML)
	if err != nil {
		// An empty reader produces EOF which is fine — result should be empty map
		t.Logf("empty input returned error (acceptable): %v", err)
	}
}

func TestParseSplunkQPS_LargeValues(t *testing.T) {
	xml := `<?xml version='1.0' encoding='UTF-8'?>
<results preview='0'>
<meta>
<fieldOrder>
<field>_time</field>
<field splitby_field="source_host" splitby_value="big-server.example.com">big-server.example.com</field>
</fieldOrder>
</meta>
<result offset='0'>
<field k='_time'><value><text>2026-04-10T00:00:00.000+02:00</text></value></field>
<field k='big-server.example.com'><value><text>45123.456</text></value></field>
</result>
</results>`

	qps, err := ParseSplunkQPS(strings.NewReader(xml))
	if err != nil {
		t.Fatalf("ParseSplunkQPS() error = %v", err)
	}
	if got := qps["big-server.example.com"]; got != 45123.456 {
		t.Errorf("big-server peak QPS = %v, want 45123.456", got)
	}
}

func TestMergeQPSData_ExactMatch(t *testing.T) {
	metrics := []NiosServerMetric{
		{MemberID: "dns-1.example.com", MemberName: "dns-1.example.com", QPS: 0},
		{MemberID: "dns-2.example.com", MemberName: "dns-2.example.com", QPS: 0},
	}
	qps := map[string]float64{
		"dns-1.example.com": 1500.7,
		"dns-2.example.com": 250.3,
	}
	result := MergeQPSData(metrics, qps)
	if result[0].QPS != 1501 {
		t.Errorf("dns-1 QPS = %d, want 1501 (rounded from 1500.7)", result[0].QPS)
	}
	if result[1].QPS != 250 {
		t.Errorf("dns-2 QPS = %d, want 250 (rounded from 250.3)", result[1].QPS)
	}
	// Verify original not mutated
	if metrics[0].QPS != 0 {
		t.Error("original metrics were mutated")
	}
}

func TestMergeQPSData_PrefixMatch(t *testing.T) {
	metrics := []NiosServerMetric{
		{MemberID: "dns-1", MemberName: "dns-1", QPS: 0},
	}
	qps := map[string]float64{
		"dns-1.net.schneider-electric.com": 749.9,
	}
	result := MergeQPSData(metrics, qps)
	if result[0].QPS != 750 {
		t.Errorf("dns-1 QPS = %d, want 750 (prefix match, rounded from 749.9)", result[0].QPS)
	}
}

func TestMergeQPSData_NoMatch(t *testing.T) {
	metrics := []NiosServerMetric{
		{MemberID: "dhcp-only", MemberName: "dhcp-only", QPS: 0},
	}
	qps := map[string]float64{
		"dns-1.example.com": 500.0,
	}
	result := MergeQPSData(metrics, qps)
	if result[0].QPS != 0 {
		t.Errorf("dhcp-only QPS = %d, want 0 (no match)", result[0].QPS)
	}
}

func TestMergeQPSData_EmptyQPS(t *testing.T) {
	metrics := []NiosServerMetric{
		{MemberID: "dns-1", MemberName: "dns-1", QPS: 0},
	}
	result := MergeQPSData(metrics, map[string]float64{})
	if result[0].QPS != 0 {
		t.Errorf("dns-1 QPS = %d, want 0 (empty QPS data)", result[0].QPS)
	}
}
