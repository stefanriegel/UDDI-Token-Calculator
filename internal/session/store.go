package session

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/infoblox/uddi-go-token-calculator/internal/broker"
)

// Store is a sync.Map-backed in-memory session store.
// sync.Map is appropriate here because reads dominate writes: one Load per
// HTTP request handler vs. one Store per session creation.
type Store struct {
	m sync.Map
}

// NewStore creates and returns an empty Store.
func NewStore() *Store {
	return &Store{}
}

// New allocates a new Session with a crypto-random ID, stores it, and returns it.
func (s *Store) New() *Session {
	sess := &Session{
		ID:        newSessionID(),
		State:     ScanStateCreated,
		StartedAt: time.Now(),
		Broker:    broker.New(),
	}
	s.m.Store(sess.ID, sess)
	return sess
}

// Get returns the Session for the given id and true, or nil and false if the
// id does not exist.
func (s *Store) Get(id string) (*Session, bool) {
	v, ok := s.m.Load(id)
	if !ok {
		return nil, false
	}
	return v.(*Session), true
}

// Delete removes the session identified by id from the store. Subsequent calls
// to Get with the same id will return nil, false.
func (s *Store) Delete(id string) {
	s.m.Delete(id)
}

// newSessionID generates a 32-character (16-byte) lowercase hex session ID
// from the system cryptographic random source. Panics if crypto/rand is
// unavailable — this would indicate a broken OS environment.
func newSessionID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b)
}
