package nios

import "testing"

func TestClassifyPlatform(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		// Empty / physical
		{"", "Physical"},
		{"physical", "Physical"},
		{"bare-metal", "Physical"},
		{"HW", "Physical"},

		// VMware variants (including real NIOS backup value "VMW")
		{"VMW", "VMware"},
		{"VNIOS", "VMware"},
		{"vmware", "VMware"},
		{"VMware", "VMware"},
		{"vsphere", "VMware"},

		// Cloud platforms (including real NIOS backup short codes: AWS, AZR, GCP)
		{"AMAZON", "AWS"},
		{"aws", "AWS"},
		{"AWS", "AWS"},
		{"AZURE", "Azure"},
		{"AZR", "Azure"},
		{"microsoft", "Azure"},
		{"GOOGLE", "GCP"},
		{"gcp", "GCP"},
		{"GCP", "GCP"},

		// Virtualization
		{"KVM", "KVM"},
		{"kvm", "KVM"},
		{"HYPERV", "Hyper-V"},
		{"hyper-v", "Hyper-V"},
		{"Hyper-V", "Hyper-V"},

		// Unknown defaults to Physical
		{"unknown_platform", "Physical"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := classifyPlatform(tt.input)
			if got != tt.want {
				t.Errorf("classifyPlatform(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestClassifyPlatformFromModel(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"IB-V4025", "VMware"},   // IB-V prefix = vNIOS
		{"IB-V2215", "VMware"},   // IB-V prefix = vNIOS
		{"IB-4030", "Physical"},  // IB- no V = physical
		{"IB-825", "Physical"},   // IB- no V = physical
		{"CP-V2205", "VMware"},   // CP-V = virtual cloud platform
		{"", ""},                 // empty -> empty
		{"UNKNOWN-123", ""},      // unknown -> empty
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := classifyPlatformFromModel(tt.input)
			if got != tt.want {
				t.Errorf("classifyPlatformFromModel(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
