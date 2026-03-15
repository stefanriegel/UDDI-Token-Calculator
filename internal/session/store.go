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

// CloneSession creates a new ScanStateCreated session that shares the credential
// structs of the session identified by oldID. The new session gets a fresh
// crypto-random ID, a new Broker, and StartedAt = now.
//
// Credentials are copied by pointer (not deep-copied) so that live token objects
// (azcore.TokenCredential, oauth2.TokenSource) are shared — this avoids a second
// browser popup for SSO/OAuth-based providers on re-scan.
//
// Returns (newSession, true) on success or (nil, false) if oldID is not found.
func (s *Store) CloneSession(oldID string) (*Session, bool) {
	old, ok := s.Get(oldID)
	if !ok {
		return nil, false
	}

	newSess := &Session{
		ID:        newSessionID(),
		State:     ScanStateCreated,
		StartedAt: time.Now(),
		Broker:    broker.New(),
		// Share credential structs — pointer copy preserves live token objects.
		AWS:         old.AWS,
		Azure:       old.Azure,
		GCP:         old.GCP,
		AD:          old.AD,
		Bluecat:     old.Bluecat,
		EfficientIP: old.EfficientIP,
		NiosWAPI:    old.NiosWAPI,
	}
	s.m.Store(newSess.ID, newSess)
	return newSess, true
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
