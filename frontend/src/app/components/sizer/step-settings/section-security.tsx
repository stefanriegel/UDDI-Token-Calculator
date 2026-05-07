/**
 * section-security.tsx — Step 4 Section C: Security.
 *
 * Per UI-SPEC §7.3 and D-20 / D-21:
 *   - Header row: <h2>Security</h2> + <Switch> for `securityEnabled`.
 *     When off, all inputs render `opacity-50 aria-disabled`.
 *   - Auto-fill: on first open of the section with `securityEnabled === true`
 *     AND auto-flag is false AND current values are 0, dispatch
 *     SECURITY_RECALC_FROM_SITES (reducer sums Σ site.verifiedAssets and
 *     Σ site.unverifiedAssets × multiplier, sets ui.securityAutoFilled).
 *     Pitfall 9: runs once per section-open, not every render.
 *   - `<AutoBadge/>` appears next to a field whose auto-flag is true.
 *   - Manual edits dispatch SET_SECURITY and reducer clears the auto-flag.
 *   - "Recalculate from Sites" button restores auto-fill + badges.
 *   - Live token preview card at bottom: calls `calculateSecurityTokens` on
 *     every render (no debounce — D-21).
 */
import { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';

import { useSizer } from '../sizer-state';
import { calculateSecurityTokens, resolveOverheads } from '../sizer-calc';
import { Switch } from '../../ui/switch';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Button } from '../../ui/button';
import { cn } from '../../ui/utils';
import { AutoBadge } from '../ui/auto-badge';
import { InlineMarker } from '../ui/inline-marker';
import { useActiveIssuesByPath } from '../sizer-validation-banner';

function formatTokens(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function SectionSecurity() {
  const { state, dispatch } = useSizer();
  const sec = state.core.security;
  const autoFilled = state.ui.securityAutoFilled;
  const sectionOpen = state.ui.sectionsOpen.security;
  const prevOpen = useRef(false);

  // Section-open auto-fill (P-09): fire once when the section transitions
  // from closed → open AND auto has not yet populated AND current values are 0.
  useEffect(() => {
    const justOpened = sectionOpen && !prevOpen.current;
    prevOpen.current = sectionOpen;
    if (!justOpened) return;
    if (!sec.securityEnabled) return;
    if (autoFilled.tdVerifiedAssets || autoFilled.tdUnverifiedAssets) return;
    if (sec.tdVerifiedAssets !== 0 || sec.tdUnverifiedAssets !== 0) return;
    dispatch({ type: 'SECURITY_RECALC_FROM_SITES' });
  }, [
    sectionOpen,
    sec.securityEnabled,
    sec.tdVerifiedAssets,
    sec.tdUnverifiedAssets,
    autoFilled.tdVerifiedAssets,
    autoFilled.tdUnverifiedAssets,
    dispatch,
  ]);

  const disabled = !sec.securityEnabled;
  const overheads = resolveOverheads(state.core);
  const total = calculateSecurityTokens(sec, overheads.security);

  // Per-row breakdown for the live preview. We inline the math for display
  // only (the authoritative total above is calculated via sizer-calc.ts).
  const tdCloudTokens = computeTdCloud(sec, overheads.security);
  const dossierTokens = computeDossier(sec, overheads.security);
  const lookalikeTokens = computeLookalikes(sec, overheads.security);

  const disabledCls = disabled ? 'opacity-50 pointer-events-none' : '';

  const issuesByPath = useActiveIssuesByPath();
  const securityIssue = issuesByPath.get('security');

  return (
    <div
      data-testid="sizer-step4-section-security-body"
      className="space-y-4"
      data-sizer-path="security"
      tabIndex={-1}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Label htmlFor="sizer-security-enabled" className="text-sm font-medium">
            Enabled
          </Label>
          <Switch
            id="sizer-security-enabled"
            data-testid="sizer-security-enabled"
            checked={sec.securityEnabled}
            onCheckedChange={(v) =>
              dispatch({ type: 'SET_SECURITY', patch: { securityEnabled: v } })
            }
          />
          {securityIssue && <InlineMarker issue={securityIssue} />}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="sizer-security-recalc"
          disabled={disabled}
          onClick={() => dispatch({ type: 'SECURITY_RECALC_FROM_SITES' })}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Recalculate from Sites
        </Button>
      </div>

      <div
        className={cn('grid gap-4', disabledCls)}
        aria-disabled={disabled ? true : undefined}
      >
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="sizer-security-verified" className="text-sm">
              Verified assets
            </Label>
            {autoFilled.tdVerifiedAssets ? <AutoBadge field="verified" /> : null}
          </div>
          <Input
            id="sizer-security-verified"
            data-testid="sizer-security-verified"
            type="number"
            min={0}
            value={sec.tdVerifiedAssets}
            disabled={disabled}
            onChange={(e) =>
              dispatch({
                type: 'SET_SECURITY',
                patch: { tdVerifiedAssets: Number(e.target.value) || 0 },
              })
            }
          />
        </div>

        <div className="grid gap-1.5">
          <div className="flex items-center gap-2">
            <Label htmlFor="sizer-security-unverified" className="text-sm">
              Unverified assets
            </Label>
            {autoFilled.tdUnverifiedAssets ? (
              <AutoBadge field="unverified" />
            ) : null}
          </div>
          <Input
            id="sizer-security-unverified"
            data-testid="sizer-security-unverified"
            type="number"
            min={0}
            value={sec.tdUnverifiedAssets}
            disabled={disabled}
            onChange={(e) =>
              dispatch({
                type: 'SET_SECURITY',
                patch: { tdUnverifiedAssets: Number(e.target.value) || 0 },
              })
            }
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-1">
          <Label htmlFor="sizer-security-soc" className="text-sm">
            SOC Insights
          </Label>
          <Switch
            id="sizer-security-soc"
            data-testid="sizer-security-soc"
            checked={sec.socInsightsEnabled}
            disabled={disabled}
            onCheckedChange={(v) =>
              dispatch({ type: 'SET_SECURITY', patch: { socInsightsEnabled: v } })
            }
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="sizer-security-dossier" className="text-sm">
            Dossier queries / day
          </Label>
          <Input
            id="sizer-security-dossier"
            data-testid="sizer-security-dossier"
            type="number"
            min={0}
            value={sec.dossierQueriesPerDay}
            disabled={disabled}
            onChange={(e) =>
              dispatch({
                type: 'SET_SECURITY',
                patch: { dossierQueriesPerDay: Number(e.target.value) || 0 },
              })
            }
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="sizer-security-lookalikes" className="text-sm">
            Lookalike domains mentioned
          </Label>
          <Input
            id="sizer-security-lookalikes"
            data-testid="sizer-security-lookalikes"
            type="number"
            min={0}
            value={sec.lookalikeDomainsMentioned}
            disabled={disabled}
            onChange={(e) =>
              dispatch({
                type: 'SET_SECURITY',
                patch: { lookalikeDomainsMentioned: Number(e.target.value) || 0 },
              })
            }
          />
        </div>
      </div>

      {/* Live token preview — D-21 */}
      <div
        data-testid="sizer-security-preview"
        className="rounded-md border border-border/60 bg-secondary px-4 py-3 mt-2"
      >
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
          Security Tokens
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
          <span>TD Cloud</span>
          <span
            data-testid="sizer-security-preview-td"
            className="tabular-nums text-right"
          >
            {formatTokens(tdCloudTokens)}
          </span>
          <span>Dossier</span>
          <span
            data-testid="sizer-security-preview-dossier"
            className="tabular-nums text-right"
          >
            {formatTokens(dossierTokens)}
          </span>
          <span>Lookalikes</span>
          <span
            data-testid="sizer-security-preview-lookalikes"
            className="tabular-nums text-right"
          >
            {formatTokens(lookalikeTokens)}
          </span>
          <span className="col-span-2 border-t border-border/50 my-1" />
          <span className="font-semibold">Total</span>
          <span
            data-testid="sizer-security-preview-total"
            className="text-xl font-bold text-primary tabular-nums text-right"
          >
            {formatTokens(total)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Local preview helpers — mirror calculateSecurityTokens row-wise ──────────
// These exist only so the preview can show a per-row breakdown; the
// authoritative Total is `calculateSecurityTokens` (D-21).

const ASSET_MULT = 3;
const SOC_MULT = 1.35;
const DOSSIER_PER_UNIT = 450; // 4500 / 10
const LOOKALIKES_PER_UNIT = 1200; // 12000 / 10

function computeTdCloud(
  sec: import('../sizer-types').SecurityInputs,
  overhead: number,
): number {
  if (!sec.securityEnabled) return 0;
  let td = (sec.tdVerifiedAssets + sec.tdUnverifiedAssets) * ASSET_MULT;
  if (sec.socInsightsEnabled) td *= SOC_MULT;
  return Math.ceil(td * (1 + overhead));
}

function computeDossier(
  sec: import('../sizer-types').SecurityInputs,
  overhead: number,
): number {
  if (!sec.securityEnabled) return 0;
  return Math.ceil(
    Math.ceil(sec.dossierQueriesPerDay / 25) *
      DOSSIER_PER_UNIT *
      (1 + overhead),
  );
}

function computeLookalikes(
  sec: import('../sizer-types').SecurityInputs,
  overhead: number,
): number {
  if (!sec.securityEnabled) return 0;
  return Math.round(
    Math.ceil(sec.lookalikeDomainsMentioned / 25) *
      LOOKALIKES_PER_UNIT *
      (1 + overhead),
  );
}
