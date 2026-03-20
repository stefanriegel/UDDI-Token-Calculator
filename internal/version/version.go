// Package version holds build-time version information injected via ldflags.
// Values are set by the CI pipeline:
//
//	go build -ldflags="-X github.com/stefanriegel/UDDI-Token-Calculator/internal/version.Version=v1.0.0-5-gabcdef1 \
//	                    -X github.com/stefanriegel/UDDI-Token-Calculator/internal/version.Commit=abcdef12 \
//	                    -X github.com/stefanriegel/UDDI-Token-Calculator/internal/version.Channel=stable"
//
// When running without ldflags (local dev), Version is "dev", Commit is "none",
// and Channel is "stable".
package version

var (
	Version = "dev"    // e.g. v1.0.0-5-gabcdef1 (git describe --tags --long --always)
	Commit  = "none"   // e.g. abcdef12 (short SHA)
	Channel = "stable" // "stable" or "dev" — controls release channel for auto-updates
)
