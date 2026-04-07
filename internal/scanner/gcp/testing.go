package gcp

import (
	"context"

	"golang.org/x/oauth2"
)

// BuildTokenSourceForTest exports buildTokenSource for use in external package tests.
// It wraps the unexported function without changing behavior.
// This is intentionally exported (not _test.go) because server_test needs cross-package access.
func BuildTokenSourceForTest(ctx context.Context, creds map[string]string, cached oauth2.TokenSource) (oauth2.TokenSource, error) {
	return buildTokenSource(ctx, creds, cached)
}
