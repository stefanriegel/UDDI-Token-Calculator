VERSION := $(shell git describe --tags --long --always 2>/dev/null || echo dev)
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS := -s -w -X github.com/infoblox/uddi-go-token-calculator/internal/version.Version=$(VERSION) -X github.com/infoblox/uddi-go-token-calculator/internal/version.Commit=$(COMMIT)

.PHONY: build build-frontend build-go clean

build: build-frontend build-go

build-frontend:
	cd frontend && pnpm install && pnpm build

build-go:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o ddi-scanner.exe .

build-local:
	go build -ldflags="$(LDFLAGS)" -o ddi-scanner .

test:
	go test ./...

clean:
	rm -f ddi-scanner ddi-scanner.exe
	rm -rf frontend/dist
