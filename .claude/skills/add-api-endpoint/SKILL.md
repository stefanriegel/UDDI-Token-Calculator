---
name: add-api-endpoint
description: Creates a new API endpoint following the chi router pattern in server/. Generates handler function, request/response types in types.go, route registration in server.go, and matching api-client.ts function. Use when user says 'add endpoint', 'new API route', 'add handler', 'create API', 'wire up backend'. Do NOT use for frontend-only changes, scanner implementations, or calculator logic.
---
# Add API Endpoint

## Critical

- All handler files live in `server/` package. Never create API handlers outside this package.
- Request/response types go in `server/types.go` — not inline in handler files.
- Every response type field must have a `json:"camelCase"` tag. Use `omitempty` for optional fields.
- Use the existing `writeJSON(w, statusCode, value)` helper from `server/scan.go` for error responses. For success responses, use `w.Header().Set("Content-Type", "application/json")` + `json.NewEncoder(w).Encode()`.
- Route registration happens in `NewRouter()` in `server/server.go` inside the `/api/v1` route group.
- The frontend mirror goes in `frontend/src/app/components/api-client.ts` with matching TypeScript interfaces.
- Never log credentials or sensitive data in handlers.

## Instructions

### Step 1: Define request/response types in `server/types.go`

Add types at the bottom of the file. Follow existing naming: `{Name}Request`, `{Name}Response`.

```go
// MyFeatureRequest is the body for POST /api/v1/my-feature.
type MyFeatureRequest struct {
	SessionID string `json:"sessionId"`
	SomeField string `json:"someField"`
}

// MyFeatureResponse is the body for POST /api/v1/my-feature.
type MyFeatureResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}
```

**Verify**: Every struct field has a `json` tag. Comment includes the HTTP method and path.

### Step 2: Create the handler in `server/{feature}.go`

Two patterns exist in the codebase:

**Stateless handler** (no dependencies — like `health.go`):
```go
package server

import (
	"encoding/json"
	"net/http"
)

// HandleMyFeature serves POST /api/v1/my-feature.
func HandleMyFeature(w http.ResponseWriter, r *http.Request) {
	var req MyFeatureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	// ... logic ...
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(MyFeatureResponse{Success: true})
}
```

**Stateful handler** (needs session store or orchestrator — like `scan.go`):
```go
package server

import (
	"encoding/json"
	"net/http"
	"github.com/stefanriegel/UDDI-Token-Calculator/internal/session"
)

type MyHandler struct {
	store *session.Store
}

func NewMyHandler(store *session.Store) *MyHandler {
	return &MyHandler{store: store}
}

func (h *MyHandler) HandleMyFeature(w http.ResponseWriter, r *http.Request) {
	// ... use h.store ...
}
```

**Verify**: Handler comment includes the HTTP method + path. Uses `writeJSON()` for errors.

### Step 3: Extract URL parameters (if needed)

Use chi's URL param extraction:
```go
import "github.com/go-chi/chi/v5"

scanId := chi.URLParam(r, "scanId")
```

Read session from cookie when body omits `sessionId`:
```go
if req.SessionID == "" {
	if cookie, err := r.Cookie("ddi_session"); err == nil {
		req.SessionID = cookie.Value
	}
}
```

### Step 4: Register the route in `server/server.go`

Add the route inside the `r.Route("/api/v1", func(r chi.Router) { ... })` block. Place it near related routes.

```go
r.Post("/my-feature", HandleMyFeature)           // stateless
r.Post("/my-feature", myHandler.HandleMyFeature)  // stateful
```

If the handler needs `store` or `orch`, register it in the `if orch != nil` block (line 88). If it works without orchestrator, add to both blocks.

**Verify**: Route appears in the correct block. Run `go build ./...` to confirm compilation.

### Step 5: Add the TypeScript client function in `api-client.ts`

Add a section in `frontend/src/app/components/api-client.ts` following the existing pattern:

```typescript
// ─── My Feature ──────────────────────────────────────────────────────────────

export interface MyFeatureResponse {
  success: boolean;
  error?: string;
}

export async function myFeature(someField: string): Promise<MyFeatureResponse> {
  const res = await fetch(apiUrl('/my-feature'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ someField }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `My feature failed: ${res.status}`);
  }
  return res.json();
}
```

**Verify**: Interface field names match Go JSON tags exactly. Uses `apiUrl()` helper. Error handling matches existing pattern.

### Step 6: Suppress noisy polling (if applicable)

If the endpoint will be polled frequently, add it to `silentPaths` in `server/server.go`:
```go
var silentPaths = map[string]bool{
	"/api/v1/health":       true,
	"/api/v1/my-feature":   true,  // polled every N seconds
}
```

### Step 7: Validate

Run `go build ./...` and `cd frontend && pnpm build` to verify both sides compile. Run `go test ./server/...` to check existing tests still pass.

## Examples

**User says**: "Add an endpoint to return the current session info"

**Actions taken**:
1. Add `SessionInfoResponse` struct to `server/types.go` with json tags
2. Create `server/session_info.go` with `HandleSessionInfo` (GET, reads `ddi_session` cookie, looks up session in store)
3. Register `r.Get("/session/info", sessionHandler.HandleSessionInfo)` in `server.go` inside `if orch != nil` block
4. Add `getSessionInfo()` function + `SessionInfoResponse` interface in `api-client.ts`
5. Run `go build ./...` and `cd frontend && pnpm build`

**Result**: `GET /api/v1/session/info` returns session metadata. Frontend can call `getSessionInfo()`.

## Common Issues

- **`writeJSON` undefined**: You're in a new file but forgot `package server` or the function is in `scan.go`. It's package-level — any file in `server/` can use it.
- **404 on new route**: Check that the route is inside the `r.Route("/api/v1", ...)` block, not outside it. Also check you added it to the correct `if orch != nil` branch.
- **JSON field mismatch between Go and TS**: Go uses `json:"camelCase"` tags. TS interface fields must match exactly. Run `curl localhost:8080/api/v1/your-endpoint` and compare field names.
- **`chi.URLParam` returns empty string**: The route pattern must use `{paramName}` syntax: `r.Get("/items/{itemId}", ...)`. The param name in `chi.URLParam(r, "itemId")` must match exactly.
- **Handler not receiving request body**: Ensure the frontend sends `Content-Type: application/json` header. For file uploads, use `multipart/form-data` (don't set Content-Type manually — let the browser set the boundary).