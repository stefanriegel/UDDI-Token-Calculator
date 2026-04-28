/**
 * use-debounced-derive.ts — 150ms debounced User→Site derive effect.
 *
 * Per CONTEXT D-12 and RESEARCH §Pattern 3:
 *   - When `site.users` is a positive finite number, after 150ms of idle the
 *     hook calls `deriveFromUsers(users, overrides)` and dispatches
 *     `SITE_DERIVE` with the result. The reducer (see `sizer-state.ts`)
 *     filters out fields flagged in `ui.siteOverrides[siteId]` so Pitfall 8
 *     (derive clobbering user overrides) cannot occur.
 *   - Cleanup clears the pending timer on unmount / dependency change
 *     (Pitfall 5): without this, unmounting the form while a timer is
 *     pending would dispatch into a dead component.
 *   - Dependencies: `[site.id, site.users, stringify(overrides), dispatch]`.
 *     JSON stringification is acceptable for ≤9 boolean/number flags; it
 *     avoids triggering on new-but-equal override objects every render.
 *
 * The hook returns nothing; it is effect-only. Callers:
 *   - sizer-step-sites.tsx (Plan 30-04, Step 2) — the only production caller.
 */
import { useEffect, type Dispatch } from 'react';

import { deriveFromUsers } from '../sizer-derive';
import type { SizerAction } from '../sizer-state';
import type { DeriveOverrides, Site } from '../sizer-types';

export const DERIVE_DEBOUNCE_MS = 150;

export function useDebouncedDerive(
  site: Pick<Site, 'id' | 'users'>,
  overrides: DeriveOverrides,
  dispatch: Dispatch<SizerAction>,
): void {
  // Stable, cheap comparator for a small flag object — see RESEARCH §Pattern 3.
  const overridesKey = JSON.stringify(overrides ?? {});

  useEffect(() => {
    const users = site.users;
    if (users == null || !Number.isFinite(users) || users <= 0) return;
    const handle = setTimeout(() => {
      const derived = deriveFromUsers(users, overrides);
      dispatch({ type: 'SITE_DERIVE', siteId: site.id, derived });
    }, DERIVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, site.users, overridesKey, dispatch]);
}
