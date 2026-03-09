// Package scanner defines the Scanner interface contract consumed by the orchestrator
// and all cloud/AD provider phases (3–6).
package scanner

import (
	"context"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
)

// Provider name constants used as stable identifiers across the codebase.
const (
	ProviderAWS   = "aws"
	ProviderAzure = "azure"
	ProviderGCP   = "gcp"
	ProviderAD    = "ad"
)

// ScanRequest carries the opaque, provider-specific inputs for a single provider scan.
// Credentials are never serialised to disk — they are held in memory only.
type ScanRequest struct {
	// Provider identifies which scanner handles this request (one of the Provider* constants).
	Provider string
	// Credentials is an opaque map of provider-specific credential fields.
	// Keys are defined per-provider (e.g. "access_key_id", "client_secret").
	Credentials map[string]string
	// Subscriptions is the list of account/subscription/project IDs to scan.
	// Interpretation depends on SelectionMode.
	Subscriptions []string
	// SelectionMode controls whether Subscriptions is an allowlist or denylist.
	// Valid values: "include" | "exclude".
	SelectionMode string
	// CachedAzureCredential carries a pre-authenticated Azure token credential
	// from the validate step so the scanner does not trigger a second browser login.
	// Nil for all non-browser-sso auth methods.
	CachedAzureCredential azcore.TokenCredential
}

// Event carries scan progress information published over the SSE stream.
// It is intentionally duplicated from any broker package to prevent import cycles.
type Event struct {
	// Type is the SSE event type (e.g. "resource_progress", "error", "provider_complete").
	Type string
	// Provider is the provider name that emitted this event.
	Provider string
	// Resource is the resource type being reported (e.g. "vpc", "subnet").
	Resource string
	// Region is the AWS region this event applies to
	// (empty for global resources and non-AWS providers).
	Region string
	// Count is the number of resources discovered for this event.
	Count int
	// Status is "done" or "error".
	Status string
	// Message carries human-readable detail, primarily for error events.
	Message string
	// DurMS is the elapsed duration in milliseconds for this resource scan.
	DurMS int64
}

// Scanner is the interface that all cloud and directory provider implementations must satisfy.
// Each provider phase (AWS=3, Azure=4, GCP=5, AD=6) registers one Scanner.
//
// The publish function is called for each resource_progress or error event during the scan.
// Implementations must not block on publish.
//
// Implementations must be safe for concurrent use: the orchestrator may call Scan
// concurrently across multiple providers.
type Scanner interface {
	Scan(ctx context.Context, req ScanRequest, publish func(Event)) ([]calculator.FindingRow, error)
}
