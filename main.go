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

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/version"

	awsscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/aws"
	azurescanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/azure"
	bluecatscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/bluecat"
	efficientipscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/efficientip"
	gcpscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/gcp"
	adscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/ad"
	niosscanner "github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner/nios"

	"github.com/stefanriegel/UDDI-Token-Calculator/internal/orchestrator"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/scanner"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
	"github.com/stefanriegel/UDDI-Token-Calculator/server"
)

func main() {
	// 1. Bind the socket FIRST — this eliminates the browser-open race condition (INFRA-03).
	//    LISTEN_ADDR env var controls bind address; default ":8080" (all interfaces) for container deployment.
	//    Set LISTEN_ADDR=127.0.0.1:0 to restore legacy loopback-only, OS-assigned-port behavior.
	listenAddr := os.Getenv("LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = ":8080"
	}
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("bind failed on %s: %v", listenAddr, err)
	}

	port := ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://localhost:%d", port)
	log.Printf("DDI Scanner version %s (%s)", version.Version, version.Commit)
	log.Printf("DDI Scanner listening on %s (url %s)", ln.Addr().String(), url)

	// 2. Build the static file handler from the embedded filesystem (INFRA-01).
	//    staticFiles is declared in embed.go (same package main) via //go:embed all:frontend/dist
	staticHandler, err := server.NewStaticHandler(staticFiles)
	if err != nil {
		log.Fatalf("static handler init: %v", err)
	}

	// 3. Create the session store and orchestrator.
	//    AWS and Azure scanners are real implementations (Phases 3 and 4).
	//    GCP scanner is the real Phase 5 implementation. AD real implementation added in Phase 6.
	store := session.NewStore()
	orch := orchestrator.New(map[string]scanner.Scanner{
		scanner.ProviderAWS:         awsscanner.New(),
		scanner.ProviderAzure:       azurescanner.New(),
		scanner.ProviderGCP:         gcpscanner.New(),
		scanner.ProviderAD:          adscanner.New(),
		scanner.ProviderNIOS:        niosscanner.New(),
		"nios-wapi":                 niosscanner.NewWAPI(),
		scanner.ProviderBluecat:     bluecatscanner.New(),
		scanner.ProviderEfficientIP: efficientipscanner.New(),
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

	// 6. Open the default browser unless NO_BROWSER=1 (headless / container mode).
	if os.Getenv("NO_BROWSER") != "1" {
		if err := browser.OpenURL(url); err != nil {
			log.Printf("could not open browser automatically; visit %s manually", url)
		}
	} else {
		log.Printf("NO_BROWSER=1 set — skipping browser open; visit %s manually", url)
	}

	// 7. Block until Ctrl+C or SIGTERM.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit
	log.Println("DDI Scanner shutting down")
}
