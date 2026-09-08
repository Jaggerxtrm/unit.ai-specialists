#!/usr/bin/env node
// Phase 0 gate (bead unitAI-rrdnt.1 VALIDATION #1): every Specialist schema field must
// appear as a row in the native-activation parity matrix. Guards PRD invariant 26 —
// "Specialist runtime features are reused or explicitly classified" — mechanically, so a
// field added to schema.ts later cannot silently escape classification.
//
// ponytail: greps the doc for the field name rather than parsing the markdown table.
// A field mentioned anywhere in the doc counts as classified. Upgrade to real table
// parsing only if a field ever gets a passing mention without a real row.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = readFileSync(join(root, 'src/specialist/schema.ts'), 'utf8');
const doc = readFileSync(join(root, 'docs/design/native-activation-reconciliation.md'), 'utf8');

// Schema leaf names: `foo: z.` inside the specialist schema, minus zod plumbing.
const IGNORE = new Set(['specialist', 'metadata', 'execution', 'prompt', 'skills',
  'capabilities', 'validation', 'stall_detection', 'mandatory_rules', 'permissions',
  'READ_ONLY', 'LOW', 'MEDIUM', 'HIGH']);

const fields = [...new Set(
  [...schema.matchAll(/^\s{2,}([a-z_][a-z0-9_]*):\s*z\./gm)].map(m => m[1]),
)].filter(f => !IGNORE.has(f));

const missing = fields.filter(f => !doc.includes(f));

console.log(`schema fields: ${fields.length}  classified: ${fields.length - missing.length}`);
if (missing.length) {
  console.error(`\nUNCLASSIFIED — add a parity-matrix row for each:\n${missing.map(f => `  • ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('OK — every schema field appears in the parity matrix.');
