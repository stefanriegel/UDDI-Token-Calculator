---
name: add-scanner-provider
description: Creates a new infrastructure scanner provider following the project's Scanner interface pattern. Generates scanner.go with Scan() method, test file, registers in main.go and orchestrator. Use when user says 'add provider', 'new scanner', 'add support for X', or creates files in internal/scanner/. Do NOT use for modifying existing scanners or fixing bugs in existing providers.
---
# Add Scanner Provider

## Critical

- **CGO_ENABLED=0**: All scanner dependencies MUST be pure Go. No C bindings.
- **No json tags on credentials**: Session credential structs intentionally omit json tags to prevent accidental serialization. Never add them.
- **Credentials are opaque maps**: Scanners receive `map[string]string` via `ScanRequest.Credentials`, not typed structs. The scanner extracts what it needs.
- **Partial failure tolerance**: The orchestrator continues running other providers if one fails. Your scanner must return an error cleanly without panicking.
- **Verify the interface compiles** before touching any other file: `go build ./internal/scanner/PROVIDER/`

## Instructions

### Step 1: Add the provider constant

File: `internal/scanner/provider.go`

Add a new constant following the existing pattern:
```go
const (
	ProviderAWS   = "aws"
	// ... existing ...
	ProviderYOUR  = "yourprovider"  // lowercase, no hyphens
)
```

**Verify**: `go build ./internal/scanner/` compiles.

### Step 2: Create the scanner package

Create directory `internal/scanner/PROVIDER/` with `scanner.go`:

```go
// Package PROVIDER implements scanner.Scanner for PROVIDER_NAME.
package PROVIDER

import (
	"context"
	"fmt"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/calculator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

// Scanner implements scanner.Scanner for PROVIDER_NAME.
type Scanner struct{}

// New returns a ready-to-use PROVIDER Scanner.
func New() *Scanner { return &Scanner{} }

// Scan implements scanner.Scanner.
func (s *Scanner) Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error) {
	// 1. Extract credentials from req.Credentials map
	baseURL := req.Credentials["provider_url"]
	if baseURL == "" {
		return nil, fmt.Errorf("provider: url is required")
	}

	// 2. Publish progress events during scan
	publish(scanner.Event{
		Type:     "resource_progress",
		Provider: scanner.ProviderYOUR,
		Resource: "dns_zones",
		Count:    count,
		Status:   "done",
	})

	// 3. Return FindingRows with correct categories
	var findings []calculator.FindingRow
	findings = append(findings, calculator.FindingRow{
		Provider:         scanner.ProviderYOUR,
		Source:           "instance-id",
		Region:           "",  // empty for non-regional resources
		Category:         calculator.CategoryDDIObjects,
		Item:             "dns_zones",
		Count:            count,
		TokensPerUnit:    calculator.TokensPerDDIObject, // 25
		ManagementTokens: ceilDiv(count, calculator.TokensPerDDIObject),
	})
	return findings, nil
}
```

Key patterns from existing scanners:
- `calculator.CategoryDDIObjects` (25 obj/token) for DNS zones, records, subnets, DHCP scopes
- `calculator.CategoryActiveIPs` (13 IP/token) for active IP addresses
- `calculator.CategoryManagedAssets` (3 asset/token) for VMs, servers, network devices
- Publish `scanner.Event` with `Type: "resource_progress"` for each resource type scanned
- Publish `scanner.Event` with `Type: "error"` for non-fatal errors (scan continues)
- Use `ceilDiv(count, divisor)` for ManagementTokens calculation

**Verify**: `go build ./internal/scanner/PROVIDER/` compiles.

### Step 3: Add session credentials struct

File: `internal/session/session.go`

Add a credentials struct (NO json tags):
```go
type ProviderCredentials struct {
	URL      string
	Username string
	Password string
	SkipTLS  bool
}
```

Add the field to the `Session` struct:
```go
type Session struct {
	// ... existing fields ...
	YourProvider *ProviderCredentials
}
```

**Verify**: `go build ./internal/session/` compiles.

### Step 4: Wire credentials in orchestrator

File: `internal/orchestrator/orchestrator.go`

Add a `case scanner.ProviderYOUR:` block in `buildScanRequest()`:
```go
case scanner.ProviderYOUR:
	if sess.YourProvider != nil {
		req.Credentials["provider_url"] = sess.YourProvider.URL
		req.Credentials["provider_username"] = sess.YourProvider.Username
		req.Credentials["provider_password"] = sess.YourProvider.Password
		if sess.YourProvider.SkipTLS {
			req.Credentials["skip_tls"] = "true"
		}
	}
```

**Verify**: `go build ./internal/orchestrator/` compiles.

### Step 5: Register in main.go

Add import alias and scanner registration:
```go
import (
	providerscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/PROVIDER"
)

// In the orchestrator.New() map:
orch := orchestrator.New(map[string]scanner.Scanner{
	// ... existing ...
	scanner.ProviderYOUR: providerscanner.New(),
})
```

**Verify**: `go build .` compiles from project root.

### Step 6: Add validate handler

File: `server/validate.go`

1. Add validator field to `ValidateHandler` struct:
```go
YourProviderValidator func(ctx context.Context, creds map[string]string) ([]SubscriptionItem, error)
```

2. Wire in `NewValidateHandler()`:
```go
YourProviderValidator: realYourProviderValidator,
```

3. Add case in `HandleValidate()` switch:
```go
case "yourprovider":
	validator = h.YourProviderValidator
```

4. Add case in `storeCredentials()` switch:
```go
case "yourprovider":
	sess.YourProvider = &session.ProviderCredentials{
		URL:      creds["provider_url"],
		Username: creds["provider_username"],
		Password: creds["provider_password"],
		SkipTLS:  creds["skip_tls"] == "true",
	}
```

5. Implement `realYourProviderValidator()` — test connectivity and return `[]SubscriptionItem`.

**Verify**: `go build ./server/` compiles.

### Step 7: Write tests

File: `internal/scanner/PROVIDER/scanner_test.go` (use internal package test — same package name):
```go
package PROVIDER

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
)

func TestScan_MissingCredentials(t *testing.T) {
	s := New()
	_, err := s.Scan(context.Background(), scanner.ScanRequest{
		Credentials: map[string]string{},
	}, func(e scanner.Event) {})
	if err == nil {
		t.Fatal("expected error for missing credentials")
	}
}
```

Use `httptest.NewServer` to mock the provider's API (see `internal/scanner/efficientip/scanner_test.go` for the pattern).

**Verify**: `go test ./internal/scanner/PROVIDER/ -count=1` passes.

### Step 8: Full build + test

Run: `go test ./... -count=1 && go build .`

## Examples

**User says**: "Add support for scanning Nokia VitalQIP"

**Actions taken**:
1. Add `ProviderVitalQIP = "vitalqip"` to `internal/scanner/provider.go`
2. Create `internal/scanner/vitalqip/scanner.go` with `Scanner` struct, `New()`, and `Scan()` that calls VitalQIP REST API
3. Add `VitalQIPCredentials` to `internal/session/session.go` and `VitalQIP *VitalQIPCredentials` to `Session`
4. Add `case scanner.ProviderVitalQIP:` to `buildScanRequest()` in orchestrator
5. Add `vitalqipscanner "...scanner/vitalqip"` import and `scanner.ProviderVitalQIP: vitalqipscanner.New()` to `main.go`
6. Add `VitalQIPValidator` to `ValidateHandler`, wire `realVitalQIPValidator`, add cases in `HandleValidate` and `storeCredentials`
7. Create `internal/scanner/vitalqip/scanner_test.go` with httptest mock server

**Result**: `go test ./... -count=1` passes, `go build .` succeeds

## Common Issues

1. **`cannot use providerscanner.New() (type *Scanner) as type scanner.Scanner`**: Your `Scan()` method signature doesn't match the interface. Must be exactly: `Scan(ctx context.Context, req scanner.ScanRequest, publish func(scanner.Event)) ([]calculator.FindingRow, error)`

2. **`import cycle not allowed`**: Scanner packages must NOT import `internal/session` or `internal/orchestrator`. Scanners only import `internal/scanner` (for types) and `internal/calculator` (for `FindingRow`). Credentials flow through `ScanRequest.Credentials` map.

3. **`undefined: ceilDiv`**: The `ceilDiv` function is in `internal/calculator/calculator.go` but unexported. Either copy the one-liner `func ceilDiv(n, d int) int { if n == 0 { return 0 }; return (n + d - 1) / d }` into your scanner, or compute `ManagementTokens` inline.

4. **Tests fail with `nil pointer` on publish**: Always pass a no-op publish function in tests: `func(e scanner.Event) {}`

5. **Provider not invoked during scan**: Check that the provider string in `main.go` registration matches the constant in `provider.go` AND that the frontend sends this exact string in the scan request's `providers` array.