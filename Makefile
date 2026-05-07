VERSION := $(shell git describe --tags --long --always 2>/dev/null || echo dev)
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
LDFLAGS := -s -w -X github.com/infoblox/uddi-go-token-calculator/internal/version.Version=$(VERSION) -X github.com/infoblox/uddi-go-token-calculator/internal/version.Commit=$(COMMIT)

.PHONY: build build-frontend build-go build-windows test clean verify-vnios-specs

# build: default local build for the current host (Mac/Linux). Use
# `make build-windows` for the cross-compiled Windows .exe.
build: build-frontend build-go

build-frontend:
	cd frontend && pnpm install && pnpm build

build-go:
	go build -ldflags="$(LDFLAGS)" -o UDDI-Token-Calculator .

# build-windows: dev-only Windows cross-compile from macOS/Linux. CGO=0 keeps
# the build hermetic (no mingw toolchain required) — SSPI (Windows SSO) is
# stubbed via the `!cgo` build tag in internal/scanner/ad/sspi_stub.go.
# Production Windows builds run via GoReleaser with CGO=1 + mingw-w64 (see
# .goreleaser*.yaml) so SSPI works at runtime.
build-windows: build-frontend
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o UDDI-Token-Calculator.exe .

test:
	go test ./...

clean:
	rm -f UDDI-Token-Calculator UDDI-Token-Calculator.exe
	rm -rf frontend/dist

# verify-vnios-specs — VNIOS_SPECS drift detector. Compares Go and TS canonical
# JSON byte-for-byte and verifies both match the committed hash file. Exits
# non-zero with a side-by-side row diff on mismatch. Wired into CI.
verify-vnios-specs:
	@go run ./cmd/verify-vnios-specs
