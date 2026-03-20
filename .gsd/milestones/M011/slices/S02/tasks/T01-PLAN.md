---
estimated_steps: 4
estimated_files: 2
skills_used:
  - test
---

# T01: Implement estimator-calc.ts with formula chain and Vitest reference tests

**Slice:** S02 — Manual Estimator Connector
**Milestone:** M011

## Description

Create `estimator-calc.ts` as a pure computation module (no React imports, no side effects) implementing the full ESTIMATOR derivation chain from the official Infoblox UDDI Estimator spreadsheet. Back it with `estimator-calc.test.ts` using three concrete reference cases whose expected outputs were verified against the spreadsheet. This is the formula-fidelity proof required by the milestone's Proof Strategy.

The module pattern follows `nios-calc.ts` — exported types, constants, and a single main `calcEstimator(inputs)` function that returns all derived values S02 and S03 need.

## Steps

1. **Create `estimator-calc.ts`** with:
   - `EstimatorInputs` interface (all questionnaire fields with defaults)
   - `EstimatorDefaults` const (from spreadsheet: QPDPerIP=3500, devicesPerUser=2.5, dnsRecsPerIP=2, dnsRecsPerLease=4, bufferOverhead=0.15, assetsPerSite=2, dhcpObjModifier=2, dhcpLeaseHours=1, daysPerMonth=31, workdaysPerMonth=22, hoursPerWorkday=9)
   - `EstimatorOutputs` interface: `{ ddiObjects: number; activeIPs: number; discoveredAssets: number; monthlyLogVolume: number; managementTokens: number }`
   - `calcEstimator(inputs: EstimatorInputs): EstimatorOutputs` implementing the full chain:
     ```
     staticClients = ROUNDDOWN(activeIPs × (1 - dhcpPct))
     dynamicClients = ROUNDUP(activeIPs × dhcpPct)
     dnsRecords = enableDNS ? (dynamicClients × dnsRecsPerLease) + (staticClients × dnsRecsPerIP) : 0
     dhcpRangeMult = enableDHCP && enableIPAM ? dhcpObjModifier : 0
     dhcpLogMult = enableDNSProtocol || enableDHCPLog ? 1 : 0
     dhcpClients = enableIPAM ? activeIPs × dhcpPct × (enableDHCPLog ? 1 : 0) : 0
     ddiObjects = Math.round((dnsRecords + (networksPerSite × sites × dhcpRangeMult)) × (1 + bufferOverhead))
     activeIPsOut = enableIPAM ? activeIPs + (assetsPerSite × sites × networksPerSite) : 0
     discoveredAssets = enableIPAM ? (assets ?? activeIPs) : 0
     dnsLogsStatic = daysPerMonth × qpdPerIP × staticClients × (enableDNSProtocol ? 1 : 0)
     dnsLogsDynamic = workdaysPerMonth × qpdPerIP × dynamicClients × (enableDNSProtocol ? 1 : 0)
     dhcpLogs = (hoursPerWorkday / (dhcpLeaseHours / 2) + 1) × workdaysPerMonth × dhcpClients × (enableDHCPLog ? 1 : 0)
     monthlyLogVolume = enableDNSProtocol || enableDHCPLog ? dnsLogsStatic + dnsLogsDynamic + dhcpLogs : 0
     ```
   - Management token calc: `ROUNDUP(ddiObjects/25,0)` + `ROUNDUP(activeIPsOut/13,0)` + `ROUNDUP(discoveredAssets/3,0)` — NOT max, but each category's tokens are individual FindingRow contributions (the max is taken by the calculator, not the estimator). Return raw counts only.

2. **Create `estimator-calc.test.ts`** with three reference test cases. Use `describe('calcEstimator', ...)` + vitest `it(...)`.

   **Reference Case A — Small office, DNS+DHCP, reporting enabled**
   Inputs: knowledgeWorkers=500, activeIPs=1250, dhcpPct=0.80, enableIPAM=true, enableDNS=true, enableDNSProtocol=true, enableDHCP=true, enableDHCPLog=true, sites=5, networksPerSite=4, ipv6=false, assets=undefined (defaults to activeIPs)
   Expected (computed from spreadsheet formulas):
   - staticClients = Math.floor(1250 × 0.20) = 250
   - dynamicClients = Math.ceil(1250 × 0.80) = 1000
   - dnsRecords = (1000 × 4) + (250 × 2) = 4500
   - dhcpRangeMult = 2 (both enabled, HA/FO modifier)
   - ddiObjects = Math.round((4500 + (4 × 5 × 2)) × 1.15) = Math.round((4500 + 40) × 1.15) = Math.round(4540 × 1.15) = Math.round(5221) = 5221
   - activeIPsOut = 1250 + (2 × 5 × 4) = 1250 + 40 = 1290
   - discoveredAssets = 1250 (assets defaults to activeIPs)
   Assert: `ddiObjects === 5221`, `activeIPs === 1290`, `discoveredAssets === 1250`, `monthlyLogVolume > 0`

   **Reference Case B — Medium enterprise, DNS only, no reporting**
   Inputs: activeIPs=5000, dhcpPct=0.80, enableIPAM=true, enableDNS=true, enableDNSProtocol=false, enableDHCP=false, enableDHCPLog=false, sites=10, networksPerSite=6, ipv6=false
   Expected:
   - staticClients = Math.floor(5000 × 0.20) = 1000
   - dynamicClients = Math.ceil(5000 × 0.80) = 4000
   - dnsRecords = (4000 × 4) + (1000 × 2) = 18000
   - dhcpRangeMult = 0 (DHCP disabled)
   - ddiObjects = Math.round(18000 × 1.15) = Math.round(20700) = 20700
   - activeIPsOut = 5000 + (2 × 10 × 6) = 5000 + 120 = 5120
   - discoveredAssets = 5000
   Assert: `ddiObjects === 20700`, `activeIPs === 5120`, `discoveredAssets === 5000`, `monthlyLogVolume === 0`

   **Reference Case C — No IPAM, DNS only**
   Inputs: activeIPs=2000, dhcpPct=0.80, enableIPAM=false, enableDNS=true, enableDNSProtocol=false, enableDHCP=false, enableDHCPLog=false, sites=3, networksPerSite=4
   Expected:
   - ddiObjects = Math.round(((1600 × 4) + (400 × 2)) × 1.15) = Math.round(7200 × 1.15) = Math.round(8280) = 8280
   - activeIPsOut = 0 (IPAM disabled)
   - discoveredAssets = 0 (IPAM disabled)
   Assert: `ddiObjects === 8280`, `activeIPs === 0`, `discoveredAssets === 0`

3. **Run vitest** to confirm all three test cases pass: `cd frontend && npx vitest run src/app/components/estimator-calc.test.ts`

4. **Verify TypeScript** is clean for the new file: `cd frontend && npx tsc --noEmit 2>&1 | grep "estimator-calc"` → no errors

## Must-Haves

- [ ] `EstimatorInputs` interface exported with all required fields and optional `assets?: number` override
- [ ] `EstimatorDefaults` const exported so wizard.tsx can initialise the questionnaire form
- [ ] `EstimatorOutputs` interface exported — must include `ddiObjects`, `activeIPs`, `discoveredAssets`, `monthlyLogVolume`
- [ ] `calcEstimator(inputs)` applies ROUNDDOWN for staticClients, ROUNDUP for dynamicClients, and `Math.round` for ddiObjects (matching spreadsheet ROUNDDOWN((value)×(1+overhead),0) semantics)
- [ ] All three reference test cases pass
- [ ] Zero TypeScript errors in the new file
- [ ] No React imports — pure computation module only

## Verification

- `cd frontend && npx vitest run src/app/components/estimator-calc.test.ts` — exits 0, all tests green
- `cd frontend && npx tsc --noEmit 2>&1 | grep "estimator-calc"` — no output (zero errors in this file)

## Inputs

- `frontend/src/app/components/nios-calc.ts` — module structure to follow (pure TS, exported types + functions)
- `frontend/src/app/components/nios-calc.test.ts` — test file pattern to follow (vitest describe/it/expect)
- `.gsd/milestones/M011/M011-CONTEXT.md` — authoritative formula chain (ESTIMATOR Formulas section) and all default constants
- `.gsd/milestones/M011/M011-RESEARCH.md` — full derivation chain with cell references

## Expected Output

- `frontend/src/app/components/estimator-calc.ts` — new pure computation module
- `frontend/src/app/components/estimator-calc.test.ts` — new Vitest test file with 3 passing reference cases
