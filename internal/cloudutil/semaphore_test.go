package cloudutil

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSemaphore_AcquireRelease(t *testing.T) {
	sem := NewSemaphore(2)

	if err := sem.Acquire(context.Background()); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if err := sem.Acquire(context.Background()); err != nil {
		t.Fatalf("second acquire: %v", err)
	}

	sem.Release()
	sem.Release()

	// Should be able to acquire again after releasing.
	if err := sem.Acquire(context.Background()); err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	sem.Release()
}

func TestSemaphore_ConcurrencyLimit(t *testing.T) {
	const limit = 3
	sem := NewSemaphore(limit)

	var (
		active  atomic.Int32
		maxSeen atomic.Int32
		wg      sync.WaitGroup
	)

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := sem.Acquire(context.Background()); err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			defer sem.Release()

			cur := active.Add(1)
			// Track max concurrent.
			for {
				prev := maxSeen.Load()
				if cur <= prev || maxSeen.CompareAndSwap(prev, cur) {
					break
				}
			}

			time.Sleep(time.Millisecond) // hold the slot briefly
			active.Add(-1)
		}()
	}

	wg.Wait()

	if max := maxSeen.Load(); max > limit {
		t.Errorf("max concurrent = %d, want <= %d", max, limit)
	}
	if max := maxSeen.Load(); max == 0 {
		t.Error("no goroutines ran concurrently")
	}
}

func TestSemaphore_ContextCancelled(t *testing.T) {
	sem := NewSemaphore(1)
	// Fill the single slot.
	if err := sem.Acquire(context.Background()); err != nil {
		t.Fatalf("initial acquire: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	err := sem.Acquire(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got: %v", err)
	}

	// Release the original slot — shouldn't panic.
	sem.Release()
}

func TestSemaphore_ZeroDefaultsToOne(t *testing.T) {
	sem := NewSemaphore(0)

	// Should succeed — capacity is 1.
	if err := sem.Acquire(context.Background()); err != nil {
		t.Fatalf("acquire with zero-default semaphore: %v", err)
	}

	// Second acquire should block — use a short timeout to prove it.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	err := sem.Acquire(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected DeadlineExceeded on second acquire, got: %v", err)
	}

	sem.Release()
}
