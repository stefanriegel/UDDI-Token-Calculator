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

	awsstub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/aws"
	azurestub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/azure"
	gcpstub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/gcp"
	adstub "github.com/infoblox/uddi-go-token-calculator/internal/scanner/ad"

	"github.com/infoblox/uddi-go-token-calculator/internal/orchestrator"
	"github.com/infoblox/uddi-go-token-calculator/internal/scanner"
	"github.com/infoblox/uddi-go-token-calculator/internal/session"
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

	// 3. Create the session store and orchestrator with all four stub scanners.
	//    Stub scanners are replaced phase-by-phase (3=AWS, 4=Azure, 5=GCP, 6=AD).
	store := session.NewStore()
	orch := orchestrator.New(map[string]scanner.Scanner{
		scanner.ProviderAWS:   &awsstub.Stub{},
		scanner.ProviderAzure: &azurestub.Stub{},
		scanner.ProviderGCP:   &gcpstub.Stub{},
		scanner.ProviderAD:    &adstub.Stub{},
	})

	// 4. Build the chi router (health endpoint + scan lifecycle + static fallback).
	router := server.NewRouter(staticHandler, store, orch)

	// 5. Start HTTP server in background goroutine.
	//    The socket is already bound — http.Serve begins accepting immediately.
	go func() {
		if err := http.Serve(ln, router); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	// 6. Open the default browser. The socket is bound before this call — no race (INFRA-03).
	if err := browser.OpenURL(url); err != nil {
		log.Printf("could not open browser automatically; visit %s manually", url)
	}

	// 7. Block until Ctrl+C or SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit
	log.Println("DDI Scanner shutting down")
}
