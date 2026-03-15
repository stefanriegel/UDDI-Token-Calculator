package gcp

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/cloudutil"
	"google.golang.org/api/googleapi"
)

func TestIsGCPRetryable_RetryableCodes(t *testing.T) {
	for _, code := range []int{429, 500, 502, 503, 504} {
		err := &googleapi.Error{Code: code, Message: fmt.Sprintf("HTTP %d", code)}
		if !isGCPRetryable(err) {
			t.Errorf("expected code %d to be retryable", code)
		}
	}
}

func TestIsGCPRetryable_NonRetryableCodes(t *testing.T) {
	for _, code := range []int{400, 403, 404} {
		err := &googleapi.Error{Code: code, Message: fmt.Sprintf("HTTP %d", code)}
		if isGCPRetryable(err) {
			t.Errorf("expected code %d to NOT be retryable", code)
		}
	}
}

func TestIsGCPRetryable_Nil(t *testing.T) {
	if isGCPRetryable(nil) {
		t.Error("expected nil error to NOT be retryable")
	}
}

func TestIsGCPRetryable_NonGoogleAPIError(t *testing.T) {
	err := errors.New("connection refused")
	if isGCPRetryable(err) {
		t.Error("expected non-googleapi error to NOT be retryable")
	}
}

func TestIsGCPRetryable_WrappedGoogleAPIError(t *testing.T) {
	inner := &googleapi.Error{Code: 429, Message: "rate limited"}
	wrapped := fmt.Errorf("compute API: %w", inner)
	if !isGCPRetryable(wrapped) {
		t.Error("expected wrapped 429 googleapi.Error to be retryable")
	}
}

func TestWrapGCPRetryable_RetryableCode(t *testing.T) {
	err := &googleapi.Error{Code: 429, Message: "rate limited"}
	wrapped := WrapGCPRetryable(err)

	// Must satisfy RetryableError.
	var re cloudutil.RetryableError
	if !errors.As(wrapped, &re) {
		t.Fatal("expected wrapped error to satisfy cloudutil.RetryableError")
	}
	if !re.IsRetryable() {
		t.Error("expected IsRetryable() to return true")
	}

	// Must satisfy RetryAfterError.
	var ra cloudutil.RetryAfterError
	if !errors.As(wrapped, &ra) {
		t.Fatal("expected wrapped error to satisfy cloudutil.RetryAfterError")
	}
	if ra.RetryAfter() != time.Duration(0) {
		t.Errorf("expected RetryAfter() == 0, got %v", ra.RetryAfter())
	}

	// Original error preserved via Unwrap.
	if !errors.Is(wrapped, err) {
		t.Error("expected wrapped error to unwrap to original googleapi.Error")
	}
}

func TestWrapGCPRetryable_NonRetryableCode(t *testing.T) {
	err := &googleapi.Error{Code: 403, Message: "forbidden"}
	result := WrapGCPRetryable(err)

	// Should return original error unchanged.
	if result != err {
		t.Error("expected non-retryable error to be returned unchanged")
	}

	// Must NOT satisfy RetryableError.
	var re cloudutil.RetryableError
	if errors.As(result, &re) {
		t.Error("non-retryable error should not satisfy cloudutil.RetryableError")
	}
}

func TestWrapGCPRetryable_NonGoogleAPIError(t *testing.T) {
	err := errors.New("timeout")
	result := WrapGCPRetryable(err)
	if result != err {
		t.Error("expected non-googleapi error to be returned unchanged")
	}
}

func TestWrapGCPRetryable_Nil(t *testing.T) {
	result := WrapGCPRetryable(nil)
	if result != nil {
		t.Error("expected nil input to return nil")
	}
}
