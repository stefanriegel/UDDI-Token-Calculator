// Package exporter builds .xlsx export files from scan session data.
// The Build function is the single entry point; it writes a valid OOXML workbook
// to the supplied io.Writer using excelize StreamWriter (no disk writes).
package exporter

import (
	"io"

	"github.com/infoblox/uddi-go-token-calculator/internal/session"
)

// Build writes a structured .xlsx workbook to w from the given completed session.
// Returns an error if excelize fails to build any sheet; the caller should not write
// any HTTP response headers until Build returns successfully.
func Build(w io.Writer, sess *session.Session) error {
	// TODO: implement in Plan 02
	return nil
}
