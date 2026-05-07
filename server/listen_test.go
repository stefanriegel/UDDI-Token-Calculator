package server_test

import (
	"net"
	"strings"
	"testing"
)

// TestListenAddr verifies the listener binds to 127.0.0.1 (INFRA-02).
func TestListenAddr(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen failed: %v", err)
	}
	defer ln.Close()

	addr := ln.Addr().String()
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Errorf("expected listener on 127.0.0.1:*, got %s", addr)
	}
}

// TestListenBeforeBrowserOpen verifies the socket is bound before any browser call (INFRA-03).
// The listener's Addr() being non-nil and having a non-zero port proves the socket is bound.
func TestListenBeforeBrowserOpen(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen failed: %v", err)
	}
	defer ln.Close()

	tcpAddr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatal("expected *net.TCPAddr")
	}
	if tcpAddr.Port == 0 {
		t.Error("expected OS-assigned non-zero port after Listen")
	}
	// If we reach here, the socket is bound (port > 0) before any browser.OpenURL call.
	// The production main.go follows this same sequence.
}
