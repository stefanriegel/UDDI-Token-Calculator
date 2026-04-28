//go:build !windows || !cgo

package ad

import (
	"context"
	"errors"
)

// ErrSSPINotAvailable is returned on non-Windows platforms where Windows SSPI
// is not available. The UI should never offer the "Windows SSO" auth method on
// non-Windows backends, so this path should never be reached in practice.
var ErrSSPINotAvailable = errors.New("Windows SSPI authentication is only available on domain-joined Windows hosts")

// SSPIWinRMClient is a stub on non-Windows platforms.
type SSPIWinRMClient struct{}

// BuildSSPIClient always returns ErrSSPINotAvailable on non-Windows platforms.
func BuildSSPIClient(host string, opts ...ClientOption) (*SSPIWinRMClient, error) {
	return nil, ErrSSPINotAvailable
}

// RunPowerShell always returns ErrSSPINotAvailable on non-Windows platforms.
func (c *SSPIWinRMClient) RunPowerShell(_ context.Context, _ string) (string, error) {
	return "", ErrSSPINotAvailable
}
