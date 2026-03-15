package aws

import (
	"testing"

	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// TestCountInstanceIPs tests the multi-NIC primary case (AWS-05).
// One reservation, one instance with 2 network interfaces:
//   - Interface 0: 2 PrivateIpAddresses (first has associated public IP, second does not)
//   - Interface 1: 1 PrivateIpAddress with no public IP
//
// Expected: 4 (3 private + 1 public from NIC 0 association)
func TestCountInstanceIPs(t *testing.T) {
	publicIP := "54.1.2.3"
	priv0 := "10.0.0.1"
	priv1 := "10.0.0.2"
	priv2 := "10.0.1.1"

	reservations := []ec2types.Reservation{
		{
			Instances: []ec2types.Instance{
				{
					NetworkInterfaces: []ec2types.InstanceNetworkInterface{
						{
							PrivateIpAddresses: []ec2types.InstancePrivateIpAddress{
								{
									PrivateIpAddress: &priv0,
									Association: &ec2types.InstanceNetworkInterfaceAssociation{
										PublicIp: &publicIP,
									},
								},
								{
									PrivateIpAddress: &priv1,
									Association:      nil,
								},
							},
						},
						{
							PrivateIpAddresses: []ec2types.InstancePrivateIpAddress{
								{
									PrivateIpAddress: &priv2,
									Association:      nil,
								},
							},
						},
					},
				},
			},
		},
	}

	got := countInstanceIPs(reservations)
	if got != 4 {
		t.Errorf("countInstanceIPs: got %d, want 4", got)
	}
}

// TestCountInstanceIPsFallback tests the fallback path (AWS-05):
// instance with empty NetworkInterfaces uses top-level PrivateIpAddress and PublicIpAddress.
// Expected: 2
func TestCountInstanceIPsFallback(t *testing.T) {
	priv := "10.0.0.1"
	pub := "54.1.2.3"

	reservations := []ec2types.Reservation{
		{
			Instances: []ec2types.Instance{
				{
					NetworkInterfaces: []ec2types.InstanceNetworkInterface{},
					PrivateIpAddress:  &priv,
					PublicIpAddress:   &pub,
				},
			},
		},
	}

	got := countInstanceIPs(reservations)
	if got != 2 {
		t.Errorf("countInstanceIPs fallback: got %d, want 2", got)
	}
}

// TestCountInstanceIPsEmpty tests that an empty reservations slice returns 0.
func TestCountInstanceIPsEmpty(t *testing.T) {
	got := countInstanceIPs([]ec2types.Reservation{})
	if got != 0 {
		t.Errorf("countInstanceIPs empty: got %d, want 0", got)
	}
}

// TestStripZoneID tests Route53 hosted zone ID stripping.
// Route53 sometimes returns IDs as "/hostedzone/Z1ABC"; we need just "Z1ABC".
func TestStripZoneID(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"/hostedzone/Z1ABC", "Z1ABC"},
		{"Z1ABC", "Z1ABC"},
		{"", ""},
	}

	for _, c := range cases {
		got := stripZoneID(c.input)
		if got != c.want {
			t.Errorf("stripZoneID(%q) = %q, want %q", c.input, got, c.want)
		}
	}
}
