// Package broker implements a non-blocking SSE event fan-out broker.
// Multiple subscribers each receive a buffered channel; slow or disconnected
// clients drop events rather than blocking Publish() callers.
package broker

import "sync"

// Event is the unit of data sent over the SSE stream to the browser.
// Fields use json tags matching the SSE event shape expected by the frontend.
type Event struct {
	Type     string `json:"type"`
	Provider string `json:"provider,omitempty"`
	Resource string `json:"resource,omitempty"`
	Region   string `json:"region,omitempty"`
	Count    int    `json:"count,omitempty"`
	Status   string `json:"status,omitempty"`
	Message  string `json:"message,omitempty"`
	DurMS    int64  `json:"duration_ms,omitempty"`
}

// channelCap is the per-subscriber buffer size. Large enough to absorb bursts
// from a fast scanner without dropping, small enough to bound memory use.
const channelCap = 32

// Broker fan-outs events to all registered subscribers.
// Publish holds only an RLock so many goroutines can publish simultaneously;
// mutations (Subscribe/Unsubscribe/Close) take a full write lock.
type Broker struct {
	mu      sync.RWMutex
	clients map[chan Event]struct{}
	closed  bool
}

// New creates and returns a ready-to-use Broker.
func New() *Broker {
	return &Broker{
		clients: make(map[chan Event]struct{}),
	}
}

// Subscribe registers a new subscriber and returns its buffered event channel.
// The channel must be passed to Unsubscribe when the client disconnects.
func (b *Broker) Subscribe() chan Event {
	ch := make(chan Event, channelCap)
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.closed {
		b.clients[ch] = struct{}{}
	} else {
		// Broker already closed — return an immediately-closed channel.
		close(ch)
	}
	return ch
}

// Unsubscribe removes ch from the subscriber set and closes it so the reader
// goroutine can exit cleanly.
func (b *Broker) Unsubscribe(ch chan Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.clients[ch]; ok {
		delete(b.clients, ch)
		close(ch)
	}
}

// Publish sends e to every subscriber. The send is non-blocking: if a
// subscriber's channel is full the event is silently dropped for that client
// and Publish continues immediately.
func (b *Broker) Publish(e Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.closed {
		return
	}
	for ch := range b.clients {
		select {
		case ch <- e:
		default:
			// Channel full — drop event for this slow client.
		}
	}
}

// Close marks the broker as closed, removes all subscribers, and closes every
// subscriber channel so their reader goroutines can detect EOF and exit.
// After Close, Publish is a no-op and Subscribe returns a pre-closed channel.
func (b *Broker) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for ch := range b.clients {
		delete(b.clients, ch)
		close(ch)
	}
}
