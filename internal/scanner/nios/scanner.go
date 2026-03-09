// Package nios is the Phase 9 stub NIOS scanner.
// Phase 10 will replace the stub Scan() with real onedb.xml parsing.
package nios

import (
	"context"

	"github.com/infoblox/uddi-go-token-calculator/internal/calculator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
)

// Scanner is the NIOS provider implementation.
type Scanner struct{}

// New returns a new NIOS Scanner stub.
func New() *Scanner { return &Scanner{} }

// Scan is a stub: returns empty findings.
// Phase 10 replaces this with onedb.xml parsing.
func (s *Scanner) Scan(_ context.Context, _ scanner.ScanRequest, _ func(scanner.Event)) ([]calculator.FindingRow, error) {
	return []calculator.FindingRow{}, nil
}
