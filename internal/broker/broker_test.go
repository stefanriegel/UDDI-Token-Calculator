package broker_test

import (
	"sync"
	"testing"
	"time"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/broker"
)

// Test 1: New() returns non-nil Broker with empty clients map
func TestBroker_New(t *testing.T) {
	b := broker.New()
	if b == nil {
		t.Fatal("New() returned nil")
	}
}

// Test 2: Subscribe() returns a buffered channel (capacity 32)
func TestBroker_Subscribe_BufferedChannel(t *testing.T) {
	b := broker.New()
	ch := b.Subscribe()
	if cap(ch) != 32 {
		t.Fatalf("expected channel capacity 32, got %d", cap(ch))
	}
}

// Test 3: Publish() sends event to all subscribers
func TestBroker_Publish_SendsToAllSubscribers(t *testing.T) {
	b := broker.New()
	ch1 := b.Subscribe()
	ch2 := b.Subscribe()

	evt := broker.Event{Type: "test", Message: "hello"}
	b.Publish(evt)

	select {
	case got := <-ch1:
		if got.Type != "test" || got.Message != "hello" {
			t.Errorf("ch1: unexpected event %+v", got)
		}
	case <-time.After(time.Second):
		t.Error("ch1: timed out waiting for event")
	}

	select {
	case got := <-ch2:
		if got.Type != "test" || got.Message != "hello" {
			t.Errorf("ch2: unexpected event %+v", got)
		}
	case <-time.After(time.Second):
		t.Error("ch2: timed out waiting for event")
	}
}

// Test 4: Publish() to a full (32-event) channel does NOT block — event is dropped, function returns immediately
func TestBroker_Publish_NonBlockingOnFullChannel(t *testing.T) {
	b := broker.New()
	ch := b.Subscribe()

	// Fill the channel to capacity
	for i := 0; i < 32; i++ {
		ch <- broker.Event{Type: "fill", Count: i}
	}

	// Now channel is full — Publish must return immediately without blocking
	done := make(chan struct{})
	go func() {
		b.Publish(broker.Event{Type: "overflow"})
		close(done)
	}()

	select {
	case <-done:
		// Publish returned without blocking
	case <-time.After(time.Second):
		t.Fatal("Publish() blocked on full channel")
	}
}

// Test 5: Unsubscribe() removes channel and closes it
func TestBroker_Unsubscribe(t *testing.T) {
	b := broker.New()
	ch := b.Subscribe()
	b.Unsubscribe(ch)

	// Channel should be closed
	select {
	case _, ok := <-ch:
		if ok {
			t.Error("channel still open after Unsubscribe()")
		}
		// closed — expected
	case <-time.After(time.Second):
		t.Error("channel was not closed by Unsubscribe()")
	}

	// Publishing after unsubscribe should not panic
	b.Publish(broker.Event{Type: "after-unsub"})
}

// Test 6: Close() closes all subscriber channels and marks broker as closed
func TestBroker_Close_ClosesAllSubscribers(t *testing.T) {
	b := broker.New()
	ch1 := b.Subscribe()
	ch2 := b.Subscribe()
	ch3 := b.Subscribe()

	b.Close()

	for i, ch := range []chan broker.Event{ch1, ch2, ch3} {
		select {
		case _, ok := <-ch:
			if ok {
				t.Errorf("ch%d: channel still open after Close()", i+1)
			}
		case <-time.After(time.Second):
			t.Errorf("ch%d: channel not closed after Close()", i+1)
		}
	}
}

// Test 7: Publish() after Close() is a no-op (no panic)
func TestBroker_Publish_AfterClose_NoPanic(t *testing.T) {
	b := broker.New()
	b.Close()

	// Must not panic
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("Publish() after Close() panicked: %v", r)
		}
	}()
	b.Publish(broker.Event{Type: "after-close"})
}

// Test 8: Multiple goroutines calling Publish() concurrently produces no data race
func TestBroker_Publish_ConcurrentNoRace(t *testing.T) {
	b := broker.New()

	// Add some subscribers to drain events
	const numSubscribers = 5
	channels := make([]chan broker.Event, numSubscribers)
	for i := 0; i < numSubscribers; i++ {
		channels[i] = b.Subscribe()
	}

	// Drain goroutines
	var drainWg sync.WaitGroup
	for _, ch := range channels {
		drainWg.Add(1)
		go func(c chan broker.Event) {
			defer drainWg.Done()
			for range c {
			}
		}(ch)
	}

	// Concurrent publishers
	const numPublishers = 20
	var wg sync.WaitGroup
	for i := 0; i < numPublishers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				b.Publish(broker.Event{Type: "concurrent", Count: n*10 + j})
			}
		}(i)
	}

	wg.Wait()
	b.Close()
	drainWg.Wait()
}
