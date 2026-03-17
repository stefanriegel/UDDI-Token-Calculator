# Quick Task: Brew user gets red error when trying to update

**Date:** 2026-03-17
**Branch:** gsd/quick/2-when-a-brew-user-try-to-autoupdate-our-a

## What Changed
- Backend returns `managedBy: "homebrew"` + informational `message` instead of an `error` string when binary is Homebrew-managed
- Frontend maps `managedBy === "homebrew"` to a new `'managed'` UpdateStatus (not `'error'`)
- UI shows a blue badge with `brew upgrade uddi-token-calculator` instead of a red error badge

## Files Modified
- `server/types.go` — added `ManagedBy` field to `SelfUpdateResponse`
- `server/update.go` — Homebrew path sets `ManagedBy: "homebrew"`, `Message`, no `Error`
- `frontend/src/app/components/api-client.ts` — added `managedBy?: string` to `SelfUpdateResponse`
- `frontend/src/app/components/use-backend.ts` — added `'managed'` to `UpdateStatus`, handle `managedBy` in `doApplyUpdate`
- `frontend/src/app/components/wizard.tsx` — added blue `'managed'` badge between `'error'` and `updateAvailable` branches

## Verification
- `go build ./...` — clean
- `go test ./server/... -run TestUpdate` — PASS
- `pnpm build` — clean (185ms, 1741 modules)
