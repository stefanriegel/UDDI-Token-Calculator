package cloudutil

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// --- test helpers ---

// retryableErr is a simple error that reports itself as retryable.
type retryableErr struct{ msg string }

func (e *retryableErr) Error() string     { return e.msg }
func (e *retryableErr) IsRetryable() bool  { return true }

// nonRetryableErr is a simple error that reports itself as non-retryable.
type nonRetryableErr struct{ msg string }

func (e *nonRetryableErr) Error() string     { return e.msg }
func (e *nonRetryableErr) IsRetryable() bool  { return false }

// retryAfterErr is an error that specifies a retry delay.
type retryAfterErr struct {
	msg   string
	delay time.Duration
}

func (e *retryAfterErr) Error() string            { return e.msg }
func (e *retryAfterErr) IsRetryable() bool         { return true }
func (e *retryAfterErr) RetryAfter() time.Duration { return e.delay }

// --- tests ---

func TestCallWithBackoff_Success(t *testing.T) {
	calls := 0
	result, err := CallWithBackoff(context.Background(), func() (string, error) {
		calls++
		return "ok", nil
	}, BackoffOptions{})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "ok" {
		t.Fatalf("expected 'ok', got %q", result)
	}
	if calls != 1 {
		t.Fatalf("expected 1 call, got %d", calls)
	}
}

func TestCallWithBackoff_RetryThenSuccess(t *testing.T) {
	calls := 0
	result, err := CallWithBackoff(context.Background(), func() (int, error) {
		calls++
		if calls < 3 {
			return 0, &retryableErr{"transient"}
		}
		return 42, nil
	}, BackoffOptions{
		BaseDelay: time.Millisecond,
		MaxDelay:  10 * time.Millisecond,
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != 42 {
		t.Fatalf("expected 42, got %d", result)
	}
	if calls != 3 {
		t.Fatalf("expected 3 calls, got %d", calls)
	}
}

func TestCallWithBackoff_MaxRetriesExceeded(t *testing.T) {
	calls := 0
	_, err := CallWithBackoff(context.Background(), func() (string, error) {
		calls++
		return "", &retryableErr{"always fails"}
	}, BackoffOptions{
		MaxRetries: 2,
		BaseDelay:  time.Millisecond,
		MaxDelay:   5 * time.Millisecond,
	})

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// initial call + 2 retries = 3 calls
	if calls != 3 {
		t.Fatalf("expected 3 calls (1 initial + 2 retries), got %d", calls)
	}
	if !strings.Contains(err.Error(), "after 3 attempts") {
		t.Fatalf("expected 'after 3 attempts' in error, got: %v", err)
	}
	// The original error should be wrapped.
	if !errors.Is(err, &retryableErr{"always fails"}) {
		// Check via string since retryableErr uses pointer semantics.
		if !strings.Contains(err.Error(), "always fails") {
			t.Fatalf("expected wrapped error to contain 'always fails', got: %v", err)
		}
	}
}

func TestCallWithBackoff_ContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	calls := 0
	start := time.Now()
	_, err := CallWithBackoff(ctx, func() (string, error) {
		calls++
		if calls == 1 {
			// Cancel after the first failure — should interrupt the backoff sleep.
			go func() {
				time.Sleep(5 * time.Millisecond)
				cancel()
			}()
		}
		return "", &retryableErr{"transient"}
	}, BackoffOptions{
		BaseDelay: 5 * time.Second, // long delay so cancellation is the fast path
		MaxDelay:  10 * time.Second,
	})
	elapsed := time.Since(start)

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got: %v", err)
	}
	// Should have exited quickly via cancellation, not waited the full 5s.
	if elapsed > time.Second {
		t.Fatalf("expected fast exit on cancellation, took %v", elapsed)
	}
}

func TestCallWithBackoff_RetryAfterOverride(t *testing.T) {
	var observedDelay time.Duration
	calls := 0
	_, err := CallWithBackoff(context.Background(), func() (string, error) {
		calls++
		if calls == 1 {
			return "", &retryAfterErr{msg: "rate limited", delay: 5 * time.Millisecond}
		}
		return "ok", nil
	}, BackoffOptions{
		BaseDelay: time.Second, // would be much longer without RetryAfter override
		MaxDelay:  10 * time.Second,
		OnRetry: func(attempt int, err error, delay time.Duration) {
			observedDelay = delay
		},
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// The OnRetry callback should have received the RetryAfter delay, not the computed one.
	if observedDelay != 5*time.Millisecond {
		t.Fatalf("expected 5ms RetryAfter delay, got %v", observedDelay)
	}
}

func TestCallWithBackoff_NonRetryableShortCircuits(t *testing.T) {
	calls := 0
	_, err := CallWithBackoff(context.Background(), func() (string, error) {
		calls++
		return "", &nonRetryableErr{"permanent"}
	}, BackoffOptions{
		MaxRetries: 5,
		BaseDelay:  time.Millisecond,
	})

	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if calls != 1 {
		t.Fatalf("expected 1 call (non-retryable should short-circuit), got %d", calls)
	}
	if !strings.Contains(err.Error(), "permanent") {
		t.Fatalf("expected 'permanent' in error, got: %v", err)
	}
}

func TestCallWithBackoff_JitterBounded(t *testing.T) {
	// Run many attempts and verify all observed delays are within bounds.
	// We use the OnRetry callback to capture delays.
	var delays []time.Duration

	baseDelay := 10 * time.Millisecond
	maxDelay := 100 * time.Millisecond
	maxRetries := 5

	_, _ = CallWithBackoff(context.Background(), func() (int, error) {
		return 0, &retryableErr{"fail"}
	}, BackoffOptions{
		MaxRetries: maxRetries,
		BaseDelay:  baseDelay,
		MaxDelay:   maxDelay,
		OnRetry: func(attempt int, err error, delay time.Duration) {
			delays = append(delays, delay)
		},
	})

	if len(delays) != maxRetries {
		t.Fatalf("expected %d delays, got %d", maxRetries, len(delays))
	}

	for i, d := range delays {
		// Full jitter: delay in [0, min(maxDelay, baseDelay * 2^attempt))
		ceiling := baseDelay * (1 << uint(i))
		if ceiling > maxDelay {
			ceiling = maxDelay
		}
		if d < 0 || d >= ceiling {
			t.Errorf("delay[%d] = %v, want [0, %v)", i, d, ceiling)
		}
	}
}

func TestCallWithBackoff_OnRetryCallback(t *testing.T) {
	type retryRecord struct {
		attempt int
		err     error
		delay   time.Duration
	}
	var records []retryRecord

	calls := 0
	_, err := CallWithBackoff(context.Background(), func() (string, error) {
		calls++
		if calls <= 2 {
			return "", &retryableErr{fmt.Sprintf("fail-%d", calls)}
		}
		return "done", nil
	}, BackoffOptions{
		MaxRetries: 3,
		BaseDelay:  time.Millisecond,
		MaxDelay:   10 * time.Millisecond,
		OnRetry: func(attempt int, err error, delay time.Duration) {
			records = append(records, retryRecord{attempt, err, delay})
		},
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 OnRetry calls, got %d", len(records))
	}
	// Attempts should be 1-based.
	if records[0].attempt != 1 {
		t.Errorf("first callback attempt = %d, want 1", records[0].attempt)
	}
	if records[1].attempt != 2 {
		t.Errorf("second callback attempt = %d, want 2", records[1].attempt)
	}
	if records[0].err.Error() != "fail-1" {
		t.Errorf("first callback err = %q, want 'fail-1'", records[0].err.Error())
	}
	if records[1].err.Error() != "fail-2" {
		t.Errorf("second callback err = %q, want 'fail-2'", records[1].err.Error())
	}
}

func TestHTTPStatusError_Retryable(t *testing.T) {
	retryableCodes := []int{429, 500, 502, 503, 504}
	nonRetryableCodes := []int{400, 401, 403, 404}

	for _, code := range retryableCodes {
		e := &HTTPStatusError{StatusCode: code}
		if !e.IsRetryable() {
			t.Errorf("HTTP %d should be retryable", code)
		}
	}
	for _, code := range nonRetryableCodes {
		e := &HTTPStatusError{StatusCode: code}
		if e.IsRetryable() {
			t.Errorf("HTTP %d should NOT be retryable", code)
		}
	}

	// Test RetryAfter.
	e := &HTTPStatusError{StatusCode: 429, RetryDelay: 5 * time.Second}
	if e.RetryAfter() != 5*time.Second {
		t.Errorf("RetryAfter = %v, want 5s", e.RetryAfter())
	}

	// Test Error() with message.
	e2 := &HTTPStatusError{StatusCode: 503, Message: "service down"}
	if e2.Error() != "service down" {
		t.Errorf("Error() = %q, want 'service down'", e2.Error())
	}

	// Test Error() without message.
	e3 := &HTTPStatusError{StatusCode: 500}
	if e3.Error() != "HTTP 500" {
		t.Errorf("Error() = %q, want 'HTTP 500'", e3.Error())
	}
}
