# T03: 09-frontend-extension-api-migration 03

**Slice:** S01 — **Milestone:** M002

## Description

Migrate api-client.ts from SSE (EventSource) to polling: remove startScanEvents/ScanEventType/ScanEvent, add getScanStatus() and uploadNiosBackup() with their response types. Replace the SSE subscription pattern in use-backend.ts with a useScanPolling() hook using setInterval.

Purpose: Completes the SSE→polling cutover on the frontend side. Plan 02 already deleted the SSE backend endpoint; this plan deletes the matching client code and adds the polling client. Plan 04 (wizard.tsx) will import useScanPolling and the new api-client functions.
Output: Updated api-client.ts (merge strategy — existing functions preserved, SSE section replaced), new useScanPolling hook in use-backend.ts.

## Must-Haves

- [ ] "api-client.ts exports uploadNiosBackup(), getScanStatus(), NiosUploadResponse, NiosGridMember, ScanStatusResponse, ProviderScanStatus"
- [ ] "api-client.ts no longer exports startScanEvents, ScanEventType, or ScanEvent"
- [ ] "cloneSession() and all other existing functions in api-client.ts are preserved"
- [ ] "use-backend.ts exports useScanPolling() hook that polls GET /api/v1/scan/{scanId}/status every 1.5s and stops on complete or error"
- [ ] "useScanPolling() cleanup clears the interval when the component unmounts or scanId changes"

## Files

- `frontend/src/app/components/api-client.ts`
- `frontend/src/app/components/use-backend.ts`
