package cloudutil

import "context"

// Semaphore is a concurrency limiter backed by a buffered channel.
// It gates access to a shared resource with a fixed capacity.
type Semaphore struct {
	ch chan struct{}
}

// NewSemaphore creates a Semaphore with the given capacity.
// If n <= 0, the capacity defaults to 1 to prevent panics.
func NewSemaphore(n int) *Semaphore {
	if n <= 0 {
		n = 1
	}
	return &Semaphore{ch: make(chan struct{}, n)}
}

// Acquire blocks until a slot is available or ctx is cancelled.
// Returns nil on success, or ctx.Err() if the context was cancelled.
func (s *Semaphore) Acquire(ctx context.Context) error {
	select {
	case s.ch <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Release frees a semaphore slot. Must be called once for each successful Acquire.
// Panics if called without a matching Acquire (empty channel receive on unbuffered state).
func (s *Semaphore) Release() {
	<-s.ch
}
