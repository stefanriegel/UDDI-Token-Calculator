/**
 * sizer-step-infra.tsx — Step 3 Infrastructure Placement.
 *
 * Per UI-SPEC §6 and CONTEXT D-16 + D-17:
 *   - Tabs: "NIOS-X Systems" | "XaaS Service Points".
 *   - NIOS-X panel: shadcn Table, columns Name | Site | Form factor | Tier | Actions.
 *     The Site column uses single-mode <SiteCombobox> (4-level indented path).
 *   - XaaS panel: cards grouped by Region. Each card: name + delete, tier
 *     Select, connections number input, sites multi-select <SiteCombobox>.
 *     When connections > tier.maxConnections an inline amber Alert shows the
 *     copy:
 *       "XaaS tier '{tier}' maxes at {max} connections; {name} has {n}. +{extra} connection tokens added."
 *     with extra = (connections - max) * XAAS_EXTRA_CONNECTION_COST.
 */
import { Trash2 } from 'lucide-react';

import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { cn } from '../ui/utils';

import {
  SERVER_TOKEN_TIERS,
  XAAS_EXTRA_CONNECTION_COST,
  XAAS_TOKEN_TIERS,
  pickServerTier,
  type ServerTokenTier,
} from '../shared/token-tiers';

import { useSizer } from './sizer-state';
import type {
  NiosXSystem,
  Region,
  Site,
  XaasConnectivity,
  XaasServicePoint,
} from './sizer-types';
import { deriveFromUsers } from './sizer-derive';
import { XAAS_POP_LOCATIONS } from './xaas-pop-locations';
import { useEffect } from 'react';
import { SiteCombobox } from './ui/site-combobox';
import { InlineMarker } from './ui/inline-marker';
import { useActiveIssuesByPath } from './sizer-validation-banner';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findXaasTier(name: string): ServerTokenTier {
  return XAAS_TOKEN_TIERS.find((t) => t.name === name) ?? XAAS_TOKEN_TIERS[1]; // fallback M
}

function findSite(regions: Region[], siteId: string): Site | undefined {
  for (const r of regions) {
    for (const c of r.countries) {
      for (const ci of c.cities) {
        const s = ci.sites.find((s) => s.id === siteId);
        if (s) return s;
      }
    }
  }
  return undefined;
}

/**
 * Compute the (qps, lps, objects) load for a Site, mirroring the Step 2 live
 * preview: prefer stored fields, fall back to `deriveFromUsers(users)` so the
 * recommendation never reads as zero on a freshly-derived site.
 */
function siteLoad(site: Site | undefined): { qps: number; lps: number; objects: number } {
  if (!site) return { qps: 0, lps: 0, objects: 0 };
  const fallback =
    site.users != null && Number.isFinite(site.users) && site.users > 0
      ? deriveFromUsers(site.users)
      : null;
  const qps = site.qps ?? fallback?.qps ?? 0;
  const lps = site.lps ?? fallback?.lps ?? 0;
  const networks = site.networksPerSite ?? fallback?.networksPerSite ?? 0;
  const zones = site.dnsZones ?? fallback?.dnsZones ?? 0;
  const dhcpScopes = site.dhcpScopes ?? fallback?.dhcpScopes ?? 0;
  return { qps, lps, objects: networks + zones + dhcpScopes };
}

function computeExtraTokens(connections: number, tier: ServerTokenTier): number {
  const max = tier.maxConnections ?? 0;
  if (connections <= max) return 0;
  return (connections - max) * XAAS_EXTRA_CONNECTION_COST;
}

// ─── NIOS-X Row ───────────────────────────────────────────────────────────────

function NiosXRow({ sys, regions }: { sys: NiosXSystem; regions: Region[] }) {
  const { dispatch } = useSizer();
  const site = sys.siteId ? findSite(regions, sys.siteId) : undefined;
  const load = siteLoad(site);
  const recommended = pickServerTier(load.qps, load.lps, load.objects);

  // Auto-derive tier when the user has not manually picked one.
  // Effect intentionally depends on the recommended tier name so it re-fires
  // when Step 2 values change. The reducer-side equality guard prevents
  // re-render loops if the tier already matches.
  useEffect(() => {
    if (sys.tierManual) return;
    if (!sys.siteId) return;
    if (sys.tierName === recommended.name) return;
    dispatch({
      type: 'UPDATE_NIOSX',
      id: sys.id,
      patch: { tierName: recommended.name },
    });
  }, [sys.id, sys.siteId, sys.tierName, sys.tierManual, recommended.name, dispatch]);

  const showRecommendationHint =
    sys.tierManual && sys.siteId && sys.tierName !== recommended.name;

  return (
    <TableRow data-testid={`sizer-niosx-row-${sys.id}`}>
      <TableCell>
        <Input
          value={sys.name}
          onChange={(e) =>
            dispatch({ type: 'UPDATE_NIOSX', id: sys.id, patch: { name: e.target.value } })
          }
          data-testid={`sizer-niosx-name-${sys.id}`}
          className="h-8"
        />
      </TableCell>
      <TableCell className="min-w-[240px]">
        <SiteCombobox
          mode="single"
          value={sys.siteId || null}
          onChange={(v) =>
            dispatch({ type: 'UPDATE_NIOSX', id: sys.id, patch: { siteId: v ?? '' } })
          }
          regions={regions}
          placeholder="Select site…"
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Select
            value={sys.tierName}
            onValueChange={(v) =>
              dispatch({
                type: 'UPDATE_NIOSX',
                id: sys.id,
                patch: { tierName: v, tierManual: true },
              })
            }
          >
            <SelectTrigger
              size="sm"
              data-testid={`sizer-niosx-tier-${sys.id}`}
              className="w-[100px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SERVER_TOKEN_TIERS.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {showRecommendationHint && (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: 'UPDATE_NIOSX',
                  id: sys.id,
                  patch: { tierName: recommended.name, tierManual: false },
                })
              }
              data-testid={`sizer-niosx-tier-recommend-${sys.id}`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              title={`Recommended for ${load.qps.toLocaleString()} QPS / ${load.lps.toLocaleString()} LPS / ${load.objects.toLocaleString()} objects`}
            >
              ↺ {recommended.name}
            </button>
          )}
        </div>
      </TableCell>
      <TableCell className="w-10">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete NIOS-X system"
          onClick={() => dispatch({ type: 'DELETE_NIOSX', id: sys.id })}
          data-testid={`sizer-niosx-delete-${sys.id}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

// ─── NIOS-X Panel ─────────────────────────────────────────────────────────────

function NiosXPanel({ regions, systems }: { regions: Region[]; systems: NiosXSystem[] }) {
  const { dispatch } = useSizer();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-medium">NIOS-X Systems</h2>
        <Button
          type="button"
          onClick={() => dispatch({ type: 'ADD_NIOSX' })}
          data-testid="sizer-niosx-add"
        >
          + Add NIOS-X
        </Button>
      </div>
      <div className="rounded-md border">
        <Table data-testid="sizer-niosx-table">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="w-10" aria-label="Actions" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {systems.map((s) => (
              <NiosXRow key={s.id} sys={s} regions={regions} />
            ))}
          </TableBody>
        </Table>
      </div>
      {systems.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No NIOS-X Systems yet. Add one to assign a Site.
        </p>
      )}
    </div>
  );
}

// ─── XaaS Card ────────────────────────────────────────────────────────────────

function XaasCard({
  sp,
  regions,
  xaasIndex,
}: {
  sp: XaasServicePoint;
  regions: Region[];
  xaasIndex: number;
}) {
  const { dispatch } = useSizer();
  const tier = findXaasTier(sp.tierName);
  const maxConn = tier.maxConnections ?? 0;
  const overflow = sp.connections > maxConn;
  const extra = computeExtraTokens(sp.connections, tier);
  const issuesByPath = useActiveIssuesByPath();
  const path = `infrastructure.xaas[${xaasIndex}]`;
  const issue = issuesByPath.get(path);

  return (
    <Card
      data-testid={`sizer-xaas-card-${sp.id}`}
      data-sizer-path={path}
      tabIndex={-1}
      className="p-4 gap-3 focus:outline-none"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1">
          <Input
            value={sp.name}
            onChange={(e) =>
              dispatch({ type: 'UPDATE_XAAS', id: sp.id, patch: { name: e.target.value } })
            }
            data-testid={`sizer-xaas-name-${sp.id}`}
            className="h-8 font-medium"
          />
          {issue && <InlineMarker issue={issue} />}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete service point"
          onClick={() => dispatch({ type: 'DELETE_XAAS', id: sp.id })}
          data-testid={`sizer-xaas-delete-${sp.id}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Tier</label>
          <Select
            value={sp.tierName}
            onValueChange={(v) =>
              dispatch({ type: 'UPDATE_XAAS', id: sp.id, patch: { tierName: v } })
            }
          >
            <SelectTrigger size="sm" data-testid={`sizer-xaas-tier-${sp.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {XAAS_TOKEN_TIERS.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label
            className="text-xs text-muted-foreground mb-1 block"
            htmlFor={`sizer-xaas-connections-${sp.id}`}
          >
            Connections
          </label>
          <Input
            id={`sizer-xaas-connections-${sp.id}`}
            type="number"
            min={0}
            value={String(sp.connections)}
            onChange={(e) =>
              dispatch({
                type: 'UPDATE_XAAS',
                id: sp.id,
                patch: { connections: Number(e.target.value) || 0 },
              })
            }
            data-testid={`sizer-xaas-connections-${sp.id}`}
            className="h-8"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Connectivity</label>
          <Select
            value={sp.connectivity ?? 'vpn'}
            onValueChange={(v) =>
              dispatch({
                type: 'UPDATE_XAAS',
                id: sp.id,
                patch: { connectivity: v as XaasConnectivity },
              })
            }
          >
            <SelectTrigger size="sm" data-testid={`sizer-xaas-connectivity-${sp.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="vpn">VPN (IPsec)</SelectItem>
              <SelectItem value="tgw">TGW (AWS Transit Gateway)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">PoP location</label>
          <Select
            value={sp.popLocation ?? 'aws-us-east-1'}
            onValueChange={(v) =>
              dispatch({ type: 'UPDATE_XAAS', id: sp.id, patch: { popLocation: v } })
            }
          >
            <SelectTrigger size="sm" data-testid={`sizer-xaas-pop-${sp.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {XAAS_POP_LOCATIONS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.provider.toUpperCase()} · {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Sites served</label>
        <div data-testid={`sizer-xaas-sites-${sp.id}`}>
          <SiteCombobox
            mode="multi"
            values={sp.connectedSiteIds}
            onChange={(v) =>
              dispatch({ type: 'UPDATE_XAAS', id: sp.id, patch: { connectedSiteIds: v } })
            }
            regions={regions}
            placeholder="Select sites…"
          />
        </div>
      </div>

      {overflow && (
        <Alert
          data-testid={`sizer-xaas-warning-${sp.id}`}
          data-severity="warning"
          className={cn(
            'border-amber-300 bg-amber-50 text-amber-900',
            '[&>svg]:text-amber-700',
          )}
        >
          XaaS tier &apos;{tier.name}&apos; maxes at {maxConn} connections; {sp.name} has{' '}
          {sp.connections}. +{extra} connection tokens added.
        </Alert>
      )}
    </Card>
  );
}

// ─── XaaS Panel ───────────────────────────────────────────────────────────────

function XaasPanel({ regions, servicePoints }: { regions: Region[]; servicePoints: XaasServicePoint[] }) {
  const { dispatch } = useSizer();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-medium">XaaS Service Points</h2>
      </div>
      {regions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No Regions defined. Add a Region in Step 1 to configure XaaS Service Points.
        </p>
      )}
      {regions.map((region) => {
        const forRegion = servicePoints.filter((sp) => sp.regionId === region.id);
        return (
          <section
            key={region.id}
            data-testid={`sizer-xaas-region-group-${region.id}`}
            className="flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium">{region.name}</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => dispatch({ type: 'ADD_XAAS', regionId: region.id })}
                data-testid={`sizer-xaas-add-${region.id}`}
              >
                + Add Service Point
              </Button>
            </div>
            {forRegion.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Service Points in this Region yet.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {forRegion.map((sp) => (
                  <XaasCard
                    key={sp.id}
                    sp={sp}
                    regions={regions}
                    xaasIndex={servicePoints.findIndex((s) => s.id === sp.id)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function SizerStepInfra() {
  const { state } = useSizer();
  const regions = state.core.regions;
  const { niosx, xaas } = state.core.infrastructure;

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="sizer-step-infra">
      <h1 className="text-2xl font-medium">Step 3 — Infrastructure Placement</h1>
      <Tabs defaultValue="niosx">
        <TabsList>
          <TabsTrigger value="niosx">NIOS-X Systems</TabsTrigger>
          <TabsTrigger value="xaas">XaaS Service Points</TabsTrigger>
        </TabsList>
        <TabsContent value="niosx" className="pt-4">
          <NiosXPanel regions={regions} systems={niosx} />
        </TabsContent>
        <TabsContent value="xaas" className="pt-4">
          <XaasPanel regions={regions} servicePoints={xaas} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
