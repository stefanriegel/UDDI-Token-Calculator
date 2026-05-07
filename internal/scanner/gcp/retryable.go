package gcp

import (
	"errors"
	"time"

	"google.golang.org/api/googleapi"
)

// gcpRetryableStatuses defines HTTP status codes from GCP APIs that are safe to retry.
var gcpRetryableStatuses = map[int]bool{
	429: true, // Too Many Requests (rate limiting)
	500: true, // Internal Server Error
	502: true, // Bad Gateway
	503: true, // Service Unavailable
	504: true, // Gateway Timeout
}

// isGCPRetryable returns true if the error is a googleapi.Error with a retryable
// HTTP status code (429, 500, 502, 503, 504).
func isGCPRetryable(err error) bool {
	if err == nil {
		return false
	}
	var gErr *googleapi.Error
	if errors.As(err, &gErr) {
		return gcpRetryableStatuses[gErr.Code]
	}
	return false
}

// gcpRetryableError wraps a googleapi.Error and satisfies both
// cloudutil.RetryableError and cloudutil.RetryAfterError interfaces.
type gcpRetryableError struct {
	inner *googleapi.Error
}

func (e *gcpRetryableError) Error() string {
	return e.inner.Error()
}

func (e *gcpRetryableError) Unwrap() error {
	return e.inner
}

// IsRetryable returns true — this wrapper is only created for retryable errors.
func (e *gcpRetryableError) IsRetryable() bool {
	return true
}

// RetryAfter returns a suggested retry delay. GCP APIs use Retry-After headers
// but the googleapi.Error doesn't expose it directly, so we return zero to let
// CallWithBackoff use its computed exponential delay.
func (e *gcpRetryableError) RetryAfter() time.Duration {
	return 0
}

// WrapGCPRetryable wraps a retryable googleapi.Error into a gcpRetryableError
// that satisfies cloudutil.RetryableError and cloudutil.RetryAfterError.
// Non-retryable errors (including non-googleapi errors) are returned unchanged.
func WrapGCPRetryable(err error) error {
	if err == nil {
		return nil
	}
	var gErr *googleapi.Error
	if errors.As(err, &gErr) && gcpRetryableStatuses[gErr.Code] {
		return &gcpRetryableError{inner: gErr}
	}
	return err
}
