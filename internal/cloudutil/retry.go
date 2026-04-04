// Package cloudutil provides shared utilities for cloud provider scanners:
// retry with exponential backoff, concurrency limiting, and related helpers.
package cloudutil

import (
	"context"
	"fmt"
	"math/rand/v2"
	"time"
)

// RetryableError is implemented by errors that know whether they should be retried.
type RetryableError interface {
	error
	IsRetryable() bool
}

// RetryAfterError is implemented by errors that carry a server-specified retry delay
// (e.g. from an HTTP Retry-After header). When present, this overrides the computed
// exponential backoff delay.
type RetryAfterError interface {
	error
	RetryAfter() time.Duration
}

// BackoffOptions configures the behavior of CallWithBackoff.
type BackoffOptions struct {
	// MaxRetries is the maximum number of retry attempts after the initial call.
	// Zero defaults to 3.
	MaxRetries int

	// BaseDelay is the base duration for exponential backoff.
	// Zero defaults to 1 second.
	BaseDelay time.Duration

	// MaxDelay caps the computed backoff delay.
	// Zero defaults to 30 seconds.
	MaxDelay time.Duration

	// IsRetryable classifies whether an error should be retried.
	// If nil, defaults to checking whether the error implements RetryableError
	// with IsRetryable() returning true.
	IsRetryable func(error) bool

	// OnRetry is called before each backoff sleep with the attempt number (1-based),
	// the error that triggered the retry, and the delay that will be slept.
	// May be nil.
	OnRetry func(attempt int, err error, delay time.Duration)
}

// CallWithBackoff calls fn and retries on retryable errors using exponential backoff
// with full jitter. It is generic — T can be any type, avoiding interface{} boxing.
//
// The backoff delay for attempt i is: random(0, min(maxDelay, baseDelay * 2^i)).
// If the error implements RetryAfterError, its RetryAfter() duration overrides the
// computed delay.
//
// Context cancellation during the backoff sleep causes an immediate return with ctx.Err().
// On retry exhaustion, the last error is returned wrapped with the attempt count.
func CallWithBackoff[T any](ctx context.Context, fn func() (T, error), opts BackoffOptions) (T, error) {
	// Apply defaults.
	if opts.MaxRetries <= 0 {
		opts.MaxRetries = 3
	}
	if opts.BaseDelay <= 0 {
		opts.BaseDelay = time.Second
	}
	if opts.MaxDelay <= 0 {
		opts.MaxDelay = 30 * time.Second
	}
	if opts.IsRetryable == nil {
		opts.IsRetryable = defaultIsRetryable
	}

	var zero T
	var lastErr error

	// attempt 0 is the initial call; attempts 1..MaxRetries are retries.
	for attempt := 0; attempt <= opts.MaxRetries; attempt++ {
		result, err := fn()
		if err == nil {
			return result, nil
		}
		lastErr = err

		// Non-retryable errors short-circuit immediately.
		if !opts.IsRetryable(err) {
			return zero, err
		}

		// If this was the last allowed attempt, don't sleep — fall through to return.
		if attempt == opts.MaxRetries {
			break
		}

		// Compute backoff delay with full jitter.
		delay := computeDelay(opts.BaseDelay, opts.MaxDelay, attempt)

		// RetryAfterError overrides the computed delay.
		if ra, ok := err.(RetryAfterError); ok {
			if d := ra.RetryAfter(); d > 0 {
				delay = d
			}
		}

		// Notify callback before sleeping (attempt is 1-based for the callback).
		if opts.OnRetry != nil {
			opts.OnRetry(attempt+1, err, delay)
		}

		// Context-aware sleep.
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return zero, ctx.Err()
		}
	}

	return zero, fmt.Errorf("after %d attempts: %w", opts.MaxRetries+1, lastErr)
}

// computeDelay returns a full-jitter backoff delay:
// random in [0, min(maxDelay, baseDelay * 2^attempt)).
func computeDelay(baseDelay, maxDelay time.Duration, attempt int) time.Duration {
	// baseDelay * 2^attempt, clamped to maxDelay.
	ceiling := baseDelay * (1 << uint(attempt))
	if ceiling > maxDelay || ceiling <= 0 { // overflow guard
		ceiling = maxDelay
	}
	// Full jitter: uniform random in [0, ceiling).
	return time.Duration(rand.Int64N(int64(ceiling)))
}

// defaultIsRetryable checks if err implements RetryableError and returns its verdict.
func defaultIsRetryable(err error) bool {
	var re RetryableError
	if e, ok := err.(RetryableError); ok {
		return e.IsRetryable()
	}
	_ = re
	return false
}

// HTTPStatusError represents an HTTP error response with status code and optional
// Retry-After duration. It implements both RetryableError and RetryAfterError.
type HTTPStatusError struct {
	StatusCode int
	RetryDelay time.Duration // parsed from Retry-After header; zero if not present
	Message    string
}

// retryableStatuses defines HTTP status codes that should be retried.
var retryableStatuses = map[int]bool{
	429: true, // Too Many Requests
	500: true, // Internal Server Error
	502: true, // Bad Gateway
	503: true, // Service Unavailable
	504: true, // Gateway Timeout
}

func (e *HTTPStatusError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("HTTP %d", e.StatusCode)
}

// IsRetryable returns true for status codes 429, 500, 502, 503, 504.
func (e *HTTPStatusError) IsRetryable() bool {
	return retryableStatuses[e.StatusCode]
}

// RetryAfter returns the server-specified retry delay, or zero if not set.
func (e *HTTPStatusError) RetryAfter() time.Duration {
	return e.RetryDelay
}
