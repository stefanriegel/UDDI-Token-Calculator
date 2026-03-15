.PHONY: build build-frontend build-go clean

build: build-frontend build-go

build-frontend:
	cd frontend && pnpm install && pnpm build

build-go:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ddi-scanner.exe ./...

build-local:
	go build -o ddi-scanner ./...

test:
	go test ./...

clean:
	rm -f ddi-scanner ddi-scanner.exe
	rm -rf frontend/dist
