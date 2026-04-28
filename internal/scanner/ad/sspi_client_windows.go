//go:build windows && cgo

package ad

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/masterzen/winrm"
	"github.com/masterzen/winrm/soap"
)

// SSPIWinRMClient wraps winrm to authenticate using a pre-acquired SSPI
// Negotiate token — the currently logged-on Windows domain user's credentials
// are used transparently without requiring username or password input.
type SSPIWinRMClient struct {
	host  string
	token []byte
	opts  []ClientOption
}

// RunPowerShell executes a PowerShell script on the DC using SSPI auth and
// returns trimmed stdout. Used by the SSPI validator and scanner.
func (c *SSPIWinRMClient) RunPowerShell(ctx context.Context, script string) (string, error) {
	o := ClientOptions{port: winrmPort}
	for _, opt := range c.opts {
		opt(&o)
	}

	endpoint := winrm.NewEndpoint(c.host, o.port, o.useHTTPS, o.insecureSkipVerify, nil, nil, nil, winrmTimeout)
	params := *winrm.DefaultParameters

	transport := &sspiTransport{
		host:  c.host,
		port:  o.port,
		https: o.useHTTPS,
		token: c.token,
	}
	params.TransportDecorator = func() winrm.Transporter { return transport }

	client, err := winrm.NewClientWithParameters(endpoint, "", "", &params)
	if err != nil {
		return "", fmt.Errorf("SSPI WinRM client: %w", err)
	}

	var stdout, stderr strings.Builder
	exitCode, err := client.RunWithContext(ctx, winrm.Powershell(script), &stdout, &stderr)
	if err != nil {
		return "", fmt.Errorf("SSPI WinRM run: %w", err)
	}
	if exitCode != 0 {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		return "", fmt.Errorf("PowerShell exited %d: %s", exitCode, msg)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// sspiTransport implements winrm.Transporter. It injects the pre-acquired
// SSPI Negotiate token into the Authorization header of every WinRM HTTP POST.
type sspiTransport struct {
	host       string
	port       int
	https      bool
	token      []byte
	httpClient *http.Client
}

func (t *sspiTransport) Transport(_ *winrm.Endpoint) error {
	t.httpClient = &http.Client{
		Timeout: winrmTimeout,
		Transport: &http.Transport{
			TLSHandshakeTimeout: 10 * time.Second,
		},
	}
	return nil
}

func (t *sspiTransport) Post(_ *winrm.Client, message *soap.SoapMessage) (string, error) {
	scheme := "http"
	if t.https {
		scheme = "https"
	}
	url := fmt.Sprintf("%s://%s:%d/wsman", scheme, t.host, t.port)

	req, err := http.NewRequest("POST", url, bytes.NewBufferString(message.String()))
	if err != nil {
		return "", fmt.Errorf("sspiTransport: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/soap+xml;charset=UTF-8")
	req.Header.Set("Authorization", "Negotiate "+base64.StdEncoding.EncodeToString(t.token))

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("sspiTransport: HTTP POST: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("sspiTransport: read response: %w", err)
	}
	return string(respBody), nil
}
