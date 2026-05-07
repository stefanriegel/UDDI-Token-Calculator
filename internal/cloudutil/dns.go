package cloudutil

import "strings"

// SupportedDNSTypes is the canonical set of DNS record types considered
// "supported" for Infoblox DDI token estimation.  This set is shared across
// all cloud scanners and DDI providers (bluecat, efficientip, etc.) to
// eliminate duplication.
var SupportedDNSTypes = map[string]struct{}{
	"A": {}, "AAAA": {}, "CNAME": {}, "MX": {}, "TXT": {},
	"CAA": {}, "SRV": {}, "SVCB": {}, "HTTPS": {}, "PTR": {},
	"NS": {}, "SOA": {}, "NAPTR": {},
}

// RecordTypeItem returns the canonical FindingRow item name for a DNS record
// type.  For example RecordTypeItem("A") returns "dns_record_a".
// An empty rrtype maps to "dns_record_other".
func RecordTypeItem(rrtype string) string {
	if rrtype == "" {
		return "dns_record_other"
	}
	return "dns_record_" + strings.ToLower(rrtype)
}
