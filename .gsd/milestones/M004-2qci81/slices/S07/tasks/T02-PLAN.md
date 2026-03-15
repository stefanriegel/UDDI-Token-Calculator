---
estimated_steps: 5
estimated_files: 1
---

# T02: Add DNS per-type label formatting, maxWorkers Advanced Options, and verify build

**Slice:** S07 — Frontend UI Extensions for Multi-Account Scanning
**Milestone:** M004-2qci81

## Description

Add human-readable formatting for per-type DNS record items from S06 (e.g., `dns_record_a` → `DNS Record (A)`), expose the backend's `maxWorkers` concurrency control via an optional Advanced Options section in the credentials step, and verify the complete frontend build.

## Steps

1. Add `formatItemLabel(item: string): string` helper function in `wizard.tsx` (near other utility functions). Logic: if `item` starts with `dns_record_`, extract the suffix, uppercase it, return `DNS Record (${suffix.toUpperCase()})`. Special case `dns_record_other` → `DNS Record (Other)`. All other items pass through unchanged.

2. Apply `formatItemLabel()` to all display points where `f.item` is rendered:
   - Top Consumer card table rows (~line 2121): `{formatItemLabel(f.item)}`
   - Main results table (~line 3049): `{formatItemLabel(f.item)}`
   - CSV export (~line 715): use `formatItemLabel(f.item)` in the CSV row
   - HTML export (~line 784): use `formatItemLabel(f.item)` in the HTML row

3. Add state for `advancedOptions` — a `Record<ProviderType, { maxWorkers: number }>` with defaults of 0 (meaning use provider default). Add a `<details>` element in the credentials step card for cloud providers (AWS, Azure, GCP), below the credential fields, containing a `maxWorkers` number input with label "Max Concurrent Workers" and help text "0 = use provider default". Follow the existing Bluecat/EfficientIP `<details>`/`<summary>` pattern.

4. Wire `maxWorkers` into `startScan()`: in the `providers` array construction, set `maxWorkers: advancedOptions[provId]?.maxWorkers || undefined` on each provider entry. The `ScanRequest` type in `api-client.ts` already supports `maxWorkers`.

5. Final verification: run `npx tsc --noEmit` (only pre-existing shadcn errors) and `npx vite build` (success).

## Must-Haves

- [ ] `formatItemLabel` correctly transforms `dns_record_a` → `DNS Record (A)`, `dns_record_cname` → `DNS Record (CNAME)`, etc.
- [ ] `formatItemLabel` passes through non-DNS items unchanged (e.g., `VPCs` stays `VPCs`)
- [ ] All `f.item` display points (top consumer cards, results table, CSV, HTML) use `formatItemLabel`
- [ ] Advanced Options section renders for cloud providers with maxWorkers input
- [ ] maxWorkers value flows through to `startScan()` API call
- [ ] `npx vite build` succeeds

## Verification

- `cd frontend && npx tsc --noEmit` — only pre-existing shadcn errors
- `cd frontend && npx vite build` — succeeds
- `grep -c 'formatItemLabel' frontend/src/app/components/wizard.tsx` returns ≥ 5 (definition + 4 call sites)
- `grep 'maxWorkers' frontend/src/app/components/wizard.tsx` shows state + input + startScan wiring

## Inputs

- `frontend/src/app/components/wizard.tsx` — after T01 changes, with org auth methods and auto-select wired
- S06 decisions — per-type DNS items use lowercase underscore naming: `dns_record_a`, `dns_record_cname`, etc.
- Existing Bluecat/EfficientIP `<details>` pattern for Advanced Options styling

## Observability Impact

### New Signals
- **DNS label formatting**: All `dns_record_*` items render as `DNS Record (X)` in UI, CSV, and HTML exports. Inspect any results table row with a DNS item to verify formatting.
- **maxWorkers in scan request**: When a non-zero maxWorkers value is set, the `/scan` POST body includes `maxWorkers: N` on the corresponding provider entry. Visible in browser DevTools → Network → POST to `/scan`.

### Inspection Surfaces
- Browser DevTools → Network → POST to `/scan` → inspect request body `providers[].maxWorkers` field.
- UI → Results step → any DNS finding row shows `DNS Record (A)` instead of `dns_record_a`.
- Exported CSV/HTML files contain formatted item labels.

### Failure Visibility
- Missing `formatItemLabel` call → raw `dns_record_*` strings appear in UI/exports — visually obvious.
- maxWorkers not wired → `maxWorkers` field absent from scan request body (check Network tab).
- TypeScript errors → caught by `npx tsc --noEmit` in CI/build pipeline.

## Expected Output

- `frontend/src/app/components/wizard.tsx` — `formatItemLabel()` helper added; all item display points updated; Advanced Options with maxWorkers for cloud providers; build verified clean
