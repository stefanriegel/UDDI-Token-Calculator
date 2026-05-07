package cloudutil

import "testing"

func TestSupportedDNSTypes_Count(t *testing.T) {
	if got := len(SupportedDNSTypes); got != 13 {
		t.Errorf("SupportedDNSTypes has %d entries, want 13", got)
	}
}

func TestSupportedDNSTypes_Members(t *testing.T) {
	want := []string{
		"A", "AAAA", "CNAME", "MX", "TXT",
		"CAA", "SRV", "SVCB", "HTTPS", "PTR",
		"NS", "SOA", "NAPTR",
	}
	for _, rr := range want {
		if _, ok := SupportedDNSTypes[rr]; !ok {
			t.Errorf("SupportedDNSTypes missing %q", rr)
		}
	}
}

func TestRecordTypeItem_SupportedTypes(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"A", "dns_record_a"},
		{"AAAA", "dns_record_aaaa"},
		{"CNAME", "dns_record_cname"},
		{"MX", "dns_record_mx"},
		{"TXT", "dns_record_txt"},
		{"CAA", "dns_record_caa"},
		{"SRV", "dns_record_srv"},
		{"SVCB", "dns_record_svcb"},
		{"HTTPS", "dns_record_https"},
		{"PTR", "dns_record_ptr"},
		{"NS", "dns_record_ns"},
		{"SOA", "dns_record_soa"},
		{"NAPTR", "dns_record_naptr"},
	}
	for _, tc := range cases {
		if got := RecordTypeItem(tc.in); got != tc.want {
			t.Errorf("RecordTypeItem(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestRecordTypeItem_UnknownType(t *testing.T) {
	// Unknown but non-empty types still produce a valid item name.
	if got := RecordTypeItem("DS"); got != "dns_record_ds" {
		t.Errorf("RecordTypeItem(\"DS\") = %q, want %q", got, "dns_record_ds")
	}
}

func TestRecordTypeItem_Empty(t *testing.T) {
	if got := RecordTypeItem(""); got != "dns_record_other" {
		t.Errorf("RecordTypeItem(\"\") = %q, want %q", got, "dns_record_other")
	}
}
