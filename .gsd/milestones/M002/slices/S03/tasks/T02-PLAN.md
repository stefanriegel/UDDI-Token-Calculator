# T02: 11-frontend-nios-features 02

**Slice:** S03 — **Milestone:** M002

## Description

Add Top Consumer Cards (FE-03) to the wizard.tsx results step: three expandable accordion cards (DNS, DHCP, IP/Network) showing top-5 findings by managementTokens across all providers.

Purpose: FE-03 — users see which sources contribute most to each DDI object category, computed client-side from the existing `findings` state.
Output: Three accordion cards injected into the results step immediately after the per-source contribution bars section.

## Must-Haves

- [ ] "Results step shows three expandable Top Consumer Cards (DNS, DHCP, IP/Network)"
- [ ] "Each card displays top 5 findings by managementTokens, sorted descending"
- [ ] "Clicking a card header toggles the member-detail rows open and closed"
- [ ] "Cards render for all providers (not NIOS-only) — if no matching items, card is hidden"

## Files

- `frontend/src/app/components/wizard.tsx`
