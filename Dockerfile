# ─── Stage 1: Frontend build ─────────────────────────────────────────────────
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY frontend/ .
RUN pnpm build

# ─── Stage 2: Go binary build ───────────────────────────────────────────────
FROM golang:1.25-alpine AS builder
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /app/frontend/dist ./frontend/dist
ARG VERSION=dev
ARG COMMIT=none
ARG CHANNEL=stable
ARG TARGETOS=linux
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -ldflags="-s -w \
      -X github.com/stefanriegel/UDDI-Token-Calculator/internal/version.Version=${VERSION} \
      -X github.com/stefanriegel/UDDI-Token-Calculator/internal/version.Commit=${COMMIT} \
      -X github.com/stefanriegel/UDDI-Token-Calculator/internal/version.Channel=${CHANNEL}" \
    -o uddi-token-calculator .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -ldflags="-s -w" \
    -o healthcheck ./cmd/healthcheck
RUN mkdir -p /tmp-empty && chmod 1777 /tmp-empty

# ─── Stage 3: Minimal scratch image ─────────────────────────────────────────
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /etc/passwd /etc/passwd
COPY --from=builder /etc/group /etc/group
COPY --from=builder /tmp-empty /tmp
COPY --from=builder /app/healthcheck /healthcheck
COPY --from=builder /app/uddi-token-calculator /uddi-token-calculator
ENV NO_BROWSER=1
EXPOSE 8080
USER nobody
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/healthcheck"]
ENTRYPOINT ["/uddi-token-calculator"]
