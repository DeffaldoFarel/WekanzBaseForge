// SECURITY: field metadata contracts for Finance aggregates (audit F-02, F-03).
//
// F-02: investments.totalUnits/totalIdr/isClosed and investment_activities.type
//       must be marked backendManaged in the provisioner mapping so the server
//       rejects forged end-user writes.
// F-03: number fields that legitimately hold NEGATIVE values (signed cash
//       flows) must provision an explicit min so the generic >=0 floor does not
//       break Sell/Loss transactions, while money fields keep the >=0 floor.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync as fsExists } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/ lives at server/tests — the dashboard repo is a SIBLING of the
// BaseForge repo (E:/MyApps/WekanzDashboard). Resolve robustly instead of
// assuming a shared parent root: try sibling-of-repo first, then fall back
// to the parent-of-server dir.
function resolveDashboardRoot(): string {
  const candidates = [
    path.resolve(__dirname, '../../../WekanzDashboard'), // <root>/BaseForge/server/tests → <root>/WekanzDashboard
    path.resolve(__dirname, '../WekanzDashboard'),       // <root>/server/tests → <root>/WekanzDashboard
  ];
  for (const c of candidates) {
    if (fsExists(path.join(c, 'scripts/migration/schema.ts'))) return c;
  }
  throw new Error(`WekanzDashboard schema.ts not found near ${__dirname} (tried ${candidates.join(', ')})`);
}
const DASHBOARD_ROOT = resolveDashboardRoot();
const schemaSrc = readFileSync(path.join(DASHBOARD_ROOT, 'scripts/migration/schema.ts'), 'utf8');

// ── F-02: backendManaged flags in the client schema manifest ────────────────

test('F-02: investments.totalUnits / totalIdr / isClosed are marked backendManaged', () => {
  const invStart = schemaSrc.indexOf('id: "investments"');
  const invEnd = schemaSrc.indexOf('id: "investment_activities"');
  assert.ok(invStart !== -1 && invEnd !== -1, 'investments collection found in schema.ts');
  const invBlock = schemaSrc.slice(invStart, invEnd);

  const totalUnits = invBlock.match(/\{ key: "totalUnits"[^}]*\}/)?.[0] ?? '';
  const totalIdr = invBlock.match(/\{ key: "totalIdr"[^}]*\}/)?.[0] ?? '';
  const isClosed = invBlock.match(/\{ key: "isClosed"[^}]*\}/)?.[0] ?? '';

  assert.match(totalUnits, /backendManaged:\s*true/, 'totalUnits must carry backendManaged: true');
  assert.match(totalIdr, /backendManaged:\s*true/, 'totalIdr must carry backendManaged: true');
  assert.match(isClosed, /backendManaged:\s*true/, 'isClosed must carry backendManaged: true');
});

test('F-02: investment_activities.type is marked backendManaged', () => {
  const actStart = schemaSrc.indexOf('id: "investment_activities"');
  const actEnd = schemaSrc.indexOf('// ── Microstock');
  assert.ok(actStart !== -1, 'investment_activities collection found in schema.ts');
  const actBlock = schemaSrc.slice(actStart, actEnd === -1 ? undefined : actEnd);

  const typeField = actBlock.match(/\{ key: "type"[^}]*\}/)?.[0] ?? '';
  assert.match(typeField, /backendManaged:\s*true/, 'type must carry backendManaged: true');
});

test('F-02: provisioner mapField forwards backendManaged for text/number/bool fields, not only enum', () => {
  const provSrc = readFileSync(path.join(DASHBOARD_ROOT, 'scripts/migration/baseforge-provision.mjs'), 'utf8');
  const mapFieldStart = provSrc.indexOf('function mapField(');
  const mapFieldEnd = provSrc.indexOf('function ', mapFieldStart + 10);
  const mapFieldBlock = provSrc.slice(mapFieldStart, mapFieldEnd === -1 ? undefined : mapFieldEnd);

  const textCase = mapFieldBlock.match(/case "string":\s*\{[\s\S]*?return[\s\S]*?;/)?.[0] ?? '';
  const numberDoubleCase = mapFieldBlock.match(/case "double":[\s\S]*?return[\s\S]*?;/)?.[0] ?? '';
  const boolCase = mapFieldBlock.match(/case "boolean":[\s\S]*?return[\s\S]*?;/)?.[0] ?? '';

  assert.match(textCase, /backendManaged/, 'string mapping must forward backendManaged (type field)');
  assert.match(numberDoubleCase, /backendManaged/, 'double mapping must forward backendManaged (totalUnits/totalIdr)');
  assert.match(boolCase, /backendManaged/, 'bool mapping must forward backendManaged (isClosed)');
});

// ── F-03: signed vs unsigned number contracts ───────────────────────────────

test('F-03: provisioner maps signed number attrs to options.signed (JSON-safe)', () => {
  const provSrc = readFileSync(path.join(DASHBOARD_ROOT, 'scripts/migration/baseforge-provision.mjs'), 'utf8');
  assert.match(provSrc, /signed \? \{ signed: true \}/, 'mapField must forward attr.signed as options.signed');
  // No CODE path may provision min: -Infinity (strip line comments first).
  const codeOnly = provSrc.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /min:\s*-Infinity/, 'min: -Infinity does not survive JSON serialization — use signed: true');
});

test('F-03: investment_activities.amount and .idr are marked signed', () => {
  const actStart = schemaSrc.indexOf('id: "investment_activities"');
  const actEnd = schemaSrc.indexOf('// ── Microstock');
  const actBlock = schemaSrc.slice(actStart, actEnd === -1 ? undefined : actEnd);

  const amount = actBlock.match(/\{ key: "amount"[^}]*\}/)?.[0] ?? '';
  const idr = actBlock.match(/\{ key: "idr"[^}]*\}/)?.[0] ?? '';

  assert.match(amount, /signed:\s*true/, 'amount must be marked signed');
  assert.match(idr, /signed:\s*true/, 'idr must be marked signed');
});

test('F-03: money fields (billings.nominal, debts_receivables.amount) keep the unsigned floor', () => {
  const billStart = schemaSrc.indexOf('id: "billings"');
  const billEnd = schemaSrc.indexOf('id: "billGroups"');
  const billBlock = schemaSrc.slice(billStart, billEnd);
  const nominal = billBlock.match(/\{ key: "nominal"[^}]*\}/)?.[0] ?? '';
  assert.match(nominal, /min:\s*0/, 'billings.nominal must keep min: 0');

  const debtStart = schemaSrc.indexOf('id: "debts_receivables"');
  const debtEnd = schemaSrc.indexOf('id: "health_runs"');
  const debtBlock = schemaSrc.slice(debtStart, debtEnd);
  const debtAmount = debtBlock.match(/\{ key: "amount"[^}]*\}/)?.[0] ?? '';
  assert.match(debtAmount, /min:\s*0/, 'debts_receivables.amount must keep min: 0');
});

test('F-03: validateValue allows signed fields to go negative but keeps unsigned floor at 0', async () => {
  const { validateValue } = await import('../src/core/fieldTypes.js');

  const signedField = { name: 'amount', type: 'number' as const, options: { signed: true } };
  const unsignedField = { name: 'nominal', type: 'number' as const, options: {} };

  // Signed: Sell (-units, -idr) and Loss (0 units, -idr) must pass.
  assert.equal(validateValue(signedField as any, -5), null, 'signed field accepts -5');
  assert.equal(validateValue(signedField as any, -100000), null, 'signed field accepts large negative');
  assert.equal(validateValue(signedField as any, 5), null, 'signed field accepts positive');

  // Unsigned: floor stays at 0 when no explicit min is provisioned.
  assert.equal(validateValue(unsignedField as any, -1) !== null, true, 'unsigned field still rejects -1');
  assert.equal(validateValue(unsignedField as any, 0), null);
  assert.equal(validateValue(unsignedField as any, 12.5), null);
});
