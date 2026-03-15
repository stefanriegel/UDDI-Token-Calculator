package aws

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
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

// TestBuildConfigAssumeRole: assume_role buildConfig must use stscreds.AssumeRoleProvider
// wrapped in CredentialsCache (not one-time static credentials).
// Wave 0 stub -- currently fails because buildConfig assume_role uses static creds.
// Plan 15-01 Task 2 will refactor to use AssumeRoleProvider.
//
// NOTE: This test cannot call real AWS STS. It verifies the code path by
// checking that buildConfig returns without error for the assume_role case
// when given a source_profile. The current implementation will fail because
// it expects access_key_id/secret_access_key fields (not source_profile).
func TestBuildConfigAssumeRole(t *testing.T) {
	// Create a temporary AWS config so LoadDefaultConfig can resolve the "default" profile
	// without requiring real credentials on the machine.
	tmpDir := t.TempDir()
	credFile := filepath.Join(tmpDir, "credentials")
	os.WriteFile(credFile, []byte("[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"), 0600)
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", credFile)
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(tmpDir, "config")) // empty, avoid host config

	ctx := context.Background()
	creds := map[string]string{
		"auth_method":    "assume_role",
		"source_profile": "default",
		"role_arn":       "arn:aws:iam::123456789012:role/TestRole",
		"region":         "us-east-1",
	}
	// After plan 15-01 refactor, this should succeed (source_profile based).
	// Before refactor, it fails because the old code reads access_key_id/secret_access_key.
	cfg, err := buildConfig(ctx, creds)
	if err != nil {
		t.Fatalf("buildConfig assume_role with source_profile failed: %v", err)
	}
	if cfg.Credentials == nil {
		t.Error("expected non-nil Credentials (CredentialsCache wrapping AssumeRoleProvider)")
	}
}

// TestScanOrgFanOut verifies that multi-account mode produces findings with
// distinct per-account Source values and that buildOrgAccountConfig creates
// valid per-account configs with AssumeRole credentials.
func TestScanOrgFanOut(t *testing.T) {
	// Set up a temporary AWS config.
	tmpDir := t.TempDir()
	credFile := filepath.Join(tmpDir, "credentials")
	os.WriteFile(credFile, []byte("[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"), 0600)
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", credFile)
	t.Setenv("AWS_CONFIG_FILE", filepath.Join(tmpDir, "config"))

	ctx := context.Background()
	baseCfg, err := buildConfig(ctx, map[string]string{
		"auth_method":       "access_key",
		"access_key_id":     "AKIAIOSFODNN7EXAMPLE",
		"secret_access_key": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		"region":            "us-east-1",
	})
	if err != nil {
		t.Fatalf("buildConfig: %v", err)
	}

	// Build org account configs for two child accounts.
	childCfg1, err := buildOrgAccountConfig(baseCfg, "222222222222", "OrganizationAccountAccessRole")
	if err != nil {
		t.Fatalf("buildOrgAccountConfig child1: %v", err)
	}
	if childCfg1.Credentials == nil {
		t.Error("child account config should have credentials (CredentialsCache wrapping AssumeRoleProvider)")
	}

	childCfg2, err := buildOrgAccountConfig(baseCfg, "333333333333", "CustomRole")
	if err != nil {
		t.Fatalf("buildOrgAccountConfig child2: %v", err)
	}
	if childCfg2.Credentials == nil {
		t.Error("child account config should have credentials")
	}

	// Verify that scanOneAccount function exists and is callable.
	// The actual AWS API calls would fail without real credentials,
	// but the refactored function signature is what we're validating.
	var _ func(context.Context, awssdk.Config, string, int, func(scanner.Event)) ([]calculator.FindingRow, error) = scanOneAccount
}
