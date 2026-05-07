/**
 * section-modules.tsx — Step 4 Section A: Modules & Logging.
 *
 * Per UI-SPEC §7.1:
 *   - 3 module Switches (IPAM, DNS, DHCP)
 *   - 2 logging Switches (DNS Logging, DHCP Logging) — dimmed when parent off
 *   - Reporting Destinations: 4 Checkboxes (CSP / S3 / CDC / Local Syslog)
 *   - Per-destination rate inputs row displaying REPORTING_RATES defaults
 *
 * Inputs are controlled via the reducer (`SET_MODULE_TOGGLE`). The outer
 * `<Collapsible>` is owned by `sizer-step-settings.tsx`.
 */
import { useSizer } from '../sizer-state';
import { REPORTING_RATES } from '../sizer-calc';
import { Switch } from '../../ui/switch';
import { Checkbox } from '../../ui/checkbox';
import { Label } from '../../ui/label';
import { Input } from '../../ui/input';
import { Separator } from '../../ui/separator';
import type { GlobalSettings } from '../sizer-types';
import { cn } from '../../ui/utils';

interface ModuleRowProps {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId: string;
  disabled?: boolean;
  description?: string;
}

function ModuleRow({
  id,
  label,
  checked,
  onChange,
  testId,
  disabled,
  description,
}: ModuleRowProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 py-2',
        disabled && 'opacity-50 pointer-events-none',
      )}
    >
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <Switch
        id={id}
        data-testid={testId}
        checked={checked}
        onCheckedChange={onChange}
        aria-disabled={disabled ? true : undefined}
      />
    </div>
  );
}

export function SectionModules() {
  const { state, dispatch } = useSizer();
  const g = state.core.globalSettings;

  const set = (key: keyof GlobalSettings, value: boolean) =>
    dispatch({ type: 'SET_MODULE_TOGGLE', key, value });

  const ipam = (g as { ipamEnabled?: boolean }).ipamEnabled ?? true;
  const dns = (g as { dnsEnabled?: boolean }).dnsEnabled ?? true;
  const dhcp = (g as { dhcpEnabled?: boolean }).dhcpEnabled ?? true;
  const dnsLogging = g.dnsLoggingEnabled ?? false;
  const dhcpLogging = g.dhcpLoggingEnabled ?? false;
  const csp = g.reportingCsp ?? true;
  const s3 = g.reportingS3 ?? false;
  const cdc = g.reportingCdc ?? false;
  const localSyslog =
    (g as { reportingLocalSyslog?: boolean }).reportingLocalSyslog ?? false;

  return (
    <div data-testid="sizer-step4-section-modules-body" className="space-y-4">
      <div className="space-y-1" data-testid="sizer-modules-group">
        <ModuleRow
          id="sizer-module-ipam"
          label="IPAM"
          checked={ipam}
          onChange={(v) =>
            set('ipamEnabled' as keyof GlobalSettings, v)
          }
          testId="sizer-module-ipam"
        />
        <ModuleRow
          id="sizer-module-dns"
          label="DNS"
          checked={dns}
          onChange={(v) => set('dnsEnabled' as keyof GlobalSettings, v)}
          testId="sizer-module-dns"
        />
        <ModuleRow
          id="sizer-module-dhcp"
          label="DHCP"
          checked={dhcp}
          onChange={(v) => set('dhcpEnabled' as keyof GlobalSettings, v)}
          testId="sizer-module-dhcp"
        />
      </div>

      <Separator />

      <div className="space-y-1" data-testid="sizer-logging-group">
        <h3 className="text-sm font-medium text-foreground">Logging</h3>
        <ModuleRow
          id="sizer-logging-dns"
          label="DNS Logging"
          checked={dnsLogging}
          onChange={(v) => set('dnsLoggingEnabled', v)}
          testId="sizer-logging-dns"
          disabled={!dns}
          description={!dns ? 'Enable DNS module to configure logging.' : undefined}
        />
        <ModuleRow
          id="sizer-logging-dhcp"
          label="DHCP Logging"
          checked={dhcpLogging}
          onChange={(v) => set('dhcpLoggingEnabled', v)}
          testId="sizer-logging-dhcp"
          disabled={!dhcp}
          description={!dhcp ? 'Enable DHCP module to configure logging.' : undefined}
        />
      </div>

      <Separator />

      <div className="space-y-3" data-testid="sizer-reporting-group">
        <h3 className="text-sm font-medium text-foreground">
          Reporting Destinations
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid="sizer-reporting-csp"
              checked={csp}
              onCheckedChange={(v) =>
                set('reportingCsp', v === true)
              }
            />
            CSP Search
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid="sizer-reporting-s3"
              checked={s3}
              onCheckedChange={(v) => set('reportingS3', v === true)}
            />
            S3 Bucket
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid="sizer-reporting-cdc"
              checked={cdc}
              onCheckedChange={(v) => set('reportingCdc', v === true)}
            />
            CDC / Ecosystem
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              data-testid="sizer-reporting-local-syslog"
              checked={localSyslog}
              onCheckedChange={(v) =>
                set('reportingLocalSyslog' as keyof GlobalSettings, v === true)
              }
            />
            Local Syslog
          </label>
        </div>

        <div
          className="grid grid-cols-3 gap-3 pt-1"
          data-testid="sizer-reporting-rates"
        >
          <RateField
            label="CSP Search"
            value={REPORTING_RATES.search}
            testId="sizer-reporting-rate-csp"
          />
          <RateField
            label="S3"
            value={REPORTING_RATES.log}
            testId="sizer-reporting-rate-s3"
          />
          <RateField
            label="CDC"
            value={REPORTING_RATES.cdc}
            testId="sizer-reporting-rate-cdc"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          tk / 10M events · Defaults from Phase 29 REPORTING_RATES.
        </p>
      </div>
    </div>
  );
}

function RateField({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={testId} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={testId}
        data-testid={testId}
        type="number"
        defaultValue={value}
        readOnly
        className="h-8 text-xs"
      />
    </div>
  );
}
