# Quick Task: Auto DNS/DHCP/AD Server Discovery after first entry in Windows AD Wizard

**Date:** 2026-03-17
**Branch:** gsd/quick/1-we-need-to-implement-an-auto-dns-dhcp-ad

## What Changed

- **Forest-wide DC/DHCP/DNS discovery** (`internal/scanner/ad/discover.go`): new `DiscoverForest()` function that connects to the seed DC via WinRM and runs two PowerShell probes:
  - `Get-ADForest` + `Get-ADDomainController -Filter *` per domain → every DC in every forest domain (including child/sibling domains), tagged with roles `DC` + `DNS`
  - `Get-DhcpServerInDC` → all AD-authorised DHCP servers (including standalone member servers that are not DCs)
  - Co-located DC+DHCP servers get a merged `["DC","DNS","DHCP"]` role list instead of appearing twice
  - Both probes are error-isolated; partial failures populate `ForestDiscovery.Errors` without aborting

- **New API endpoint** `POST /api/v1/providers/ad/discover` (`server/validate.go`, `server/server.go`): accepts seed credentials, calls `DiscoverForest` with a 30s deadline, returns `ADDiscoverResponse` with `domainControllers`, `dhcpServers`, `forestName`, and `errors`. Returns HTTP 200 even on partial failures.

- **New server types** (`server/types.go`): `ADDiscoverRequest`, `ADDiscoverResponse`, `ADDiscoveredServer`

- **Frontend API client** (`frontend/src/app/components/api-client.ts`): `discoverADServers()` async function with matching TypeScript types

- **Wizard auto-discovery UX** (`frontend/src/app/components/wizard.tsx`):
  - `triggerADDiscovery()` fires automatically after the `microsoft` provider validates successfully (NTLM/WinRM methods; Kerberos skipped as it uses a different auth path)
  - Shows a spinning "Scanning forest…" indicator while in progress
  - Reveals a green discovery panel listing new DCs/DNS servers and standalone DHCP servers not already in the user's list
  - Each row shows hostname, IP, domain, and role badge with an individual **Add** button
  - **Add All** button adds every discovered server to the credentials list in one click
  - Dismiss (×) closes the panel without adding
  - State resets on wizard restart or navigating back

## Files Modified

- `internal/scanner/ad/discover.go` *(new)*
- `internal/scanner/ad/discover_test.go` *(new)*
- `server/types.go`
- `server/server.go`
- `server/validate.go`
- `server/validate_test.go`
- `frontend/src/app/components/api-client.ts`
- `frontend/src/app/components/wizard.tsx`

## Verification

- **Go build**: `go build ./...` — clean, zero errors
- **AD scanner tests** (`go test ./internal/scanner/ad/...`): all 17 tests pass (14 existing + 3 new: `TestAppendRole_Dedup`, `TestForestDiscovery_Fields`, `TestDCAlsoRunsDHCP_MergesRoles`)
- **Server tests** (`go test ./server/...`): all tests pass including 3 new discover tests (`TestHandleADDiscover_MissingServer`, `TestHandleADDiscover_InvalidBody`, `TestHandleADDiscover_UnreachableHost`)
- **Frontend build**: `vite build` — clean, 277 KB bundle
- Happy path: validates seed DC → discovery fires → panel shows additional DCs/DHCP → Add All merges them into servers list
- Failure path: unreachable host → HTTP 200 with empty slices + errors array (non-blocking UX)
- Kerberos auth: discovery silently skipped (no-op) since it requires a different WinRM setup
