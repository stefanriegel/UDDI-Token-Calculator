# UDDI Token Calculator

Go + React monorepo. Single binary with embedded web UI that scans cloud infrastructure (AWS, Azure, GCP), Active Directory, NIOS Grids, BlueCat, and EfficientIP to estimate Infoblox Universal DDI management tokens.

## Build & Run

```bash
# Full build (frontend + Go binary)
make build

# Frontend only
cd frontend && pnpm install && pnpm build

# Go binary only (requires frontend/dist)
CGO_ENABLED=0 go build -ldflags="-s -w" -o uddi-token-calculator .

# Windows cross-compile (CGO for SSPI)
CGO_ENABLED=1 CC=x86_64-w64-mingw32-gcc GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o uddi-token-calculator.exe .

# Dev server (frontend with API proxy to :8080)
cd frontend && pnpm dev
```

## Test

```bash
# Go tests
go test ./... -count=1

# Frontend tests (vitest)
cd frontend && pnpm test
```

## Docker

```bash
# Build and run via Docker Compose (uses Dockerfile multi-stage build)
docker compose up -d

# Health check (uses cmd/healthcheck/main.go)
curl http://localhost:8080/api/v1/health
```

## Architecture

**Entry**: `main.go` → binds `net.Listen` → `server.NewRouter()` → opens browser

**Backend** (`server/`): chi v5 router, `server.go` mounts routes, `types.go` defines all API request/response structs, `scan.go` handles scan lifecycle, `export.go` Excel download, `health.go` health and version endpoints, `update.go` self-update, `validate.go` credential validation, `embed.go` SPA static handler

**Scanners** (`internal/scanner/`): `provider.go` defines `Scanner` interface + `ScanRequest`/`Event` types. Implementations: `aws/scanner.go`, `azure/scanner.go`, `gcp/scanner.go`, `ad/scanner.go`, `nios/scanner.go` (backup) + `nios/wapi.go` (live API), `bluecat/scanner.go`, `efficientip/scanner.go`

**Orchestrator** (`internal/orchestrator/orchestrator.go`): runs scanners concurrently per provider, collects `FindingRow` results, calls `calculator.Calculate()`

**Calculator** (`internal/calculator/calculator.go`): DDI=25 obj/token, Active IPs=13/token, Assets=3/token, Grand Total = max(DDI, IP, Asset)

**Session** (`internal/session/`): `store.go` manages sessions, `session.go` holds per-provider credentials + scan state + `broker.Broker` for progress events

**Broker** (`internal/broker/broker.go`): pub/sub for scan progress events, fan-out to polling clients

**Exporter** (`internal/exporter/exporter.go`): excelize StreamWriter, Summary/TokenCalc/per-provider/Errors/SKU/Migration Planner sheets

**Frontend** (`frontend/`): React 18 + Vite 8 + Tailwind CSS 4 + Radix UI (shadcn). Entry `src/main.tsx` → `src/app/App.tsx` → `src/app/components/wizard.tsx`. API client at `src/app/components/api-client.ts`. Token calc logic in `src/app/components/nios-calc.ts` and `estimator-calc.ts`. UI components in `src/app/components/ui/`. Theme in `frontend/src/styles/theme.css` (Infoblox brand colors). Path alias `@/*` → `./src/*`

**Embed**: `embed.go` declares `staticFiles embed.FS`, `server/embed.go` creates SPA handler with `fs.Sub()` fallback

**CI/CD** (`.github/`): `workflows/release.yml` runs GoReleaser on tag push, `workflows/dependabot-auto-merge.yml` auto-merges patch updates, `dependabot.yml` configures dependency scanning. Versioned release notes in `.github/release-notes/` (v1.0.0 through v2.5.0)

**Docs** (`docs/`): `docs/images/` contains project screenshots for README and release notes

**Browser artifacts** (`.artifacts/browser/`): Playwright browser binaries cached for local testing

**Shell manifest** (`.bg-shell/manifest.json`): background shell configuration for the dev environment

## Key Patterns

- **Scanner interface**: `Scan(ctx, ScanRequest, publish func(Event)) ([]FindingRow, error)` — all providers implement this
- **Finding rows**: `calculator.FindingRow{Provider, Source, Region, Category, Item, Count, TokensPerUnit, ManagementTokens}`
- **Progress**: scanners call `publish(scanner.Event{...})` → orchestrator forwards to `broker.Broker` → polling API returns `ScanStatusResponse`
- **Concurrency**: `cloudutil.NewSemaphore(n)` for region/subscription/project fan-out, `checkpoint.Checkpoint` for resumable multi-unit scans
- **API prefix**: all endpoints under `/api/v1/` — health, version, validate, scan, scan status, results, export, update, session/clone, nios/upload, ad/discover
- **Session cookie**: `ddi_session` — credentials stored server-side, never re-sent after validation
- **Frontend polling**: `use-backend.ts` polls `/api/v1/scan/{id}/status` until complete

## CI/CD & Distribution

- **GoReleaser**: `.goreleaser.yaml` (stable), `.goreleaser-dev.yaml` (dev channel). Builds darwin_arm64, linux_amd64, windows_amd64. Homebrew tap at `stefanriegel/homebrew-tap`
- **Docker**: `Dockerfile` multi-stage (node:22 → golang:1.25 → scratch). `docker-compose.yml` for deployment. Healthcheck via `cmd/healthcheck/main.go`
- **Install scripts**: `scripts/install.sh` (macOS/Linux), `scripts/install.ps1` (Windows). Support `--channel stable|dev`
- **Version**: `internal/version/version.go` — `Version`, `Commit`, `Channel` set via ldflags

## Constraints

- `CGO_ENABLED=0` for all non-Windows builds (pure Go deps)
- Windows needs `CGO_ENABLED=1` for SSPI (`internal/scanner/ad/sspi_windows.go`)
- Bind to `127.0.0.1` locally (avoids Windows Firewall dialog), `:8080` in Docker
- Azure: `ClientSecretCredential` explicitly, never `DefaultAzureCredential`
- NIOS backup: `.tar.gz`/`.tgz`/`.bak`, max 500MB multipart POST
- No Google Fonts — system font stack in `frontend/src/styles/fonts.css`
- Credentials stay in-memory only, zeroed after scan via `session.ZeroCreds()`

<!-- caliber:managed:pre-commit -->
## Before Committing

Run `caliber refresh` before creating git commits to keep docs in sync with code changes.
After it completes, stage any modified doc files before committing:

```bash
caliber refresh && git add CLAUDE.md .claude/ .cursor/ .github/copilot-instructions.md AGENTS.md CALIBER_LEARNINGS.md 2>/dev/null
```
<!-- /caliber:managed:pre-commit -->

<!-- caliber:managed:learnings -->
## Session Learnings

Read `CALIBER_LEARNINGS.md` for patterns and anti-patterns learned from previous sessions.
These are auto-extracted from real tool usage — treat them as project-specific rules.
<!-- /caliber:managed:learnings -->
