// Package version holds build-time version information injected via ldflags.
// Values are set by the CI pipeline:
//
//	go build -ldflags="-X github.com/infoblox/uddi-go-token-calculator/internal/version.Version=v1.0.0-5-gabcdef1 \
//	                    -X github.com/infoblox/uddi-go-token-calculator/internal/version.Commit=abcdef12"
//
// When running without ldflags (local dev), Version is "dev" and Commit is "none".
package version

var (
	Version = "dev"  // e.g. v1.0.0-5-gabcdef1 (git describe --tags --long --always)
	Commit  = "none" // e.g. abcdef12 (short SHA)
)
