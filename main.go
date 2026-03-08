package main

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/pkg/browser"

	"github.com/infoblox/uddi-go-token-calculator/server"
)

func main() {
	// 1. Bind the socket FIRST — this eliminates the browser-open race condition (INFRA-03).
	//    "127.0.0.1:0" binds to loopback only (INFRA-02) with an OS-assigned free port.
	//    Using ":0" instead would bind to 0.0.0.0 and trigger Windows Firewall dialog.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("bind failed: %v", err)
	}

	port := ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	log.Printf("DDI Scanner serving at %s", url)

	// 2. Build the static file handler from the embedded filesystem (INFRA-01).
	//    staticFiles is declared in embed.go (same package main) via //go:embed all:frontend/dist
	staticHandler, err := server.NewStaticHandler(staticFiles)
	if err != nil {
		log.Fatalf("static handler init: %v", err)
	}

	// 3. Build the chi router (health endpoint + static fallback).
	router := server.NewRouter(staticHandler)

	// 4. Start HTTP server in background goroutine.
	//    The socket is already bound — http.Serve begins accepting immediately.
	go func() {
		if err := http.Serve(ln, router); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	// 5. Open the default browser. The socket is bound before this call — no race (INFRA-03).
	if err := browser.OpenURL(url); err != nil {
		log.Printf("could not open browser automatically; visit %s manually", url)
	}

	// 6. Block until Ctrl+C or SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit
	log.Println("DDI Scanner shutting down")
}
