// print-vnios-hash.ts — Tiny CLI that prints the TS-side canonical VNIOS_SPECS
// JSON or SHA256 hash to stdout. Used by `cmd/verify-vnios-specs/main.go` to
// cross-check Go and TS canonical outputs.
//
// Usage (from frontend/):
//   npx tsx scripts/print-vnios-hash.ts          # prints SHA256 hex hash
//   npx tsx scripts/print-vnios-hash.ts json     # prints canonical JSON

import {
  canonicalVnioSpecsJSON,
  computeVnioSpecsHash,
} from '../src/app/components/resource-savings';

const mode = process.argv[2] ?? 'hash';

(async () => {
  if (mode === 'json') {
    process.stdout.write(canonicalVnioSpecsJSON());
  } else if (mode === 'hash') {
    process.stdout.write(await computeVnioSpecsHash());
  } else {
    process.stderr.write(`unknown mode: ${mode} (expected 'hash' or 'json')\n`);
    process.exit(2);
  }
})().catch((err) => {
  process.stderr.write(`print-vnios-hash failed: ${err}\n`);
  process.exit(1);
});
