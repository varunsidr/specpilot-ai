import type { QuantityContract } from '../types.ts';

export type QuantityRule = { operation: 'add' | 'subtract'; bound: 'stock' | 'minimum' | 'none';
  guard: 'stock_or_unavailable' | 'full_step_or_unavailable' | 'at_minimum' | 'known_stock_at_minimum' | 'never'; step: number; minimum: number };
export type QuantityCheck = { caseId: string; action: 'click' | 'assert_disabled' | 'assert_unchanged'; expectedEnabled: boolean; expectedQuantity: number };
export type QuantityState = { caseId: string; quantity: number; stock: number | null; productUnavailable: boolean };
export type QuantityResult = QuantityState & { criterion: number; requiredEnabled: boolean; actualEnabled: boolean; requiredQuantity: number; actualQuantity: number; issues: string[] };
const object = <T>(value: unknown, keys: string[]): T => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new Error('Invalid structured quantity fields');
  return value as T;
};
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1000000;

// Synthetic boundary states owned by the backend, not selected to suit the model's formula.
export function quantityStates(c: QuantityContract): QuantityState[] {
  const state = (caseId: string, quantity: number, stock: number | null, productUnavailable = false) => ({ caseId, quantity, stock, productUnavailable });
  const q = c.minimum, s = c.step;
  if (c.direction === 'increase') return [state('ordinary', q, q + 3 * s),
    ...(s > 1 ? [state('partial', q + s, q + s + 1)] : []), state('limit', q + 2 * s, q + 2 * s),
    state('zero_stock', q, 0), state('unknown_stock', q + s, null), state('unavailable_product', q, null, true)];
  return [state('ordinary', q + 2 * s, q + 3 * s), ...(s > 1 ? [state('partial', q + 1, q + 3 * s)] : []),
    state('minimum', q, q + 3 * s), state('unknown_stock', q + s, null), state('unknown_minimum', q, null), state('unavailable_product', q + s, null, true)];
}

export function quantitySchema(c: QuantityContract) {
  const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
  const number = { type: 'integer', minimum: 1, maximum: 1000000 };
  const states = quantityStates(c);
  return {
    quantityRule: obj({ operation: { type: 'string', enum: ['add', 'subtract'] }, bound: { type: 'string', enum: ['stock', 'minimum', 'none'] },
      guard: { type: 'string', enum: ['stock_or_unavailable', 'full_step_or_unavailable', 'at_minimum', 'known_stock_at_minimum', 'never'] }, step: number, minimum: number }),
    quantityChecks: { type: 'array', minItems: states.length, maxItems: states.length, items: obj({ caseId: { type: 'string', enum: states.map(s => s.caseId) },
      action: { type: 'string', enum: ['click', 'assert_disabled', 'assert_unchanged'] }, expectedEnabled: { type: 'boolean' }, expectedQuantity: { type: 'integer', minimum: -1000000, maximum: 1000000 } }) },
  };
}

export function validateQuantityFields(rule: unknown, checks: unknown, contract: QuantityContract): { rule: QuantityRule; checks: QuantityCheck[] } {
  const r = object<QuantityRule>(rule, ['operation', 'bound', 'guard', 'step', 'minimum']);
  if (!['add', 'subtract'].includes(r.operation) || !['stock', 'minimum', 'none'].includes(r.bound) ||
      !['stock_or_unavailable', 'full_step_or_unavailable', 'at_minimum', 'known_stock_at_minimum', 'never'].includes(r.guard) || !integer(r.step) || !integer(r.minimum)) throw new Error('Invalid structured quantity rule');
  const states = quantityStates(contract);
  if (!Array.isArray(checks) || checks.length !== states.length) throw new Error('Cover every backend quantity boundary case exactly once');
  const seen = new Set<string>();
  for (const value of checks) {
    const check = object<QuantityCheck>(value, ['caseId', 'action', 'expectedEnabled', 'expectedQuantity']);
    if (!states.some(s => s.caseId === check.caseId) || seen.has(check.caseId) || !['click', 'assert_disabled', 'assert_unchanged'].includes(check.action) || typeof check.expectedEnabled !== 'boolean' || !Number.isSafeInteger(check.expectedQuantity) || Math.abs(check.expectedQuantity) > 1000000) throw new Error('Invalid or duplicate structured quantity case');
    seen.add(check.caseId);
  }
  return { rule: r, checks: checks as QuantityCheck[] };
}

function enabled(r: QuantityRule, s: QuantityState): boolean {
  switch (r.guard) {
    case 'stock_or_unavailable': return !s.productUnavailable && (s.stock === null || (s.stock > 0 && s.quantity < s.stock));
    case 'full_step_or_unavailable': return !s.productUnavailable && (s.stock === null || (s.stock > 0 && s.quantity + r.step <= s.stock));
    case 'at_minimum': return s.quantity > r.minimum;
    case 'known_stock_at_minimum': return !(s.stock !== null && s.quantity <= r.minimum);
    case 'never': return true;
  }
}

export function quantityOutcome(c: QuantityContract, r: QuantityRule, s: QuantityState) {
  const actualEnabled = enabled(r, s);
  const requiredEnabled = c.direction === 'increase' ? !s.productUnavailable && (s.stock === null || (s.stock > 0 && s.quantity < s.stock)) : s.quantity > c.minimum || r.guard === 'never';
  const transformed = s.quantity + (r.operation === 'add' ? r.step : -r.step);
  const actualQuantity = !actualEnabled ? s.quantity : r.bound === 'stock' && s.stock !== null ? Math.min(transformed, s.stock) : r.bound === 'minimum' ? Math.max(r.minimum, transformed) : transformed;
  const requiredQuantity = !requiredEnabled ? s.quantity : c.direction === 'increase' ? s.stock === null ? s.quantity + c.step : Math.min(s.quantity + c.step, s.stock) : Math.max(c.minimum, s.quantity - c.step);
  return { actualEnabled, requiredEnabled, actualQuantity, requiredQuantity };
}

export function checkQuantityScenarios(c: QuantityContract, r: QuantityRule, checks: QuantityCheck[]): { results: QuantityResult[]; issues: string[] } {
  const issues: string[] = [];
  if (r.step !== c.step || r.minimum !== c.minimum || r.operation !== (c.direction === 'increase' ? 'add' : 'subtract') || r.bound !== (c.direction === 'increase' ? 'stock' : 'minimum')) issues.push(`Criterion ${c.criterion}: Quantity operation, bounds, step and minimum must match the caller contract.`);
  if (!(c.direction === 'increase' ? ['stock_or_unavailable'] : ['at_minimum', 'never']).includes(r.guard)) issues.push(`Criterion ${c.criterion}: Quantity guard violates the caller contract; partial steps must remain enabled and stock must not govern decreasing.`);
  const results = quantityStates(c).map(s => {
    const check = checks.find(check => check.caseId === s.caseId)!;
    const { actualEnabled, requiredEnabled, actualQuantity, requiredQuantity } = quantityOutcome(c, r, s);
    const findings: string[] = [];
    if (actualEnabled !== requiredEnabled || check.expectedEnabled !== requiredEnabled) findings.push(`enabled must be ${requiredEnabled}`);
    if (actualQuantity !== requiredQuantity || check.expectedQuantity !== requiredQuantity) findings.push(`quantity must be ${requiredQuantity} (rule gives ${actualQuantity}, expectation ${check.expectedQuantity})`);
    if (check.action === 'click' && (!actualEnabled || !requiredEnabled)) findings.push('required click is disabled');
    if (check.action === 'assert_disabled' && (actualEnabled || requiredEnabled)) findings.push('control must remain enabled');
    if (check.action === 'assert_unchanged' && requiredQuantity !== s.quantity) findings.push('unchanged assertion skips the required action');
    const scoped = findings.map(f => `Criterion ${c.criterion}, ${s.caseId}: ${f}.`);
    issues.push(...scoped);
    return { ...s, criterion: c.criterion, requiredEnabled, actualEnabled, requiredQuantity, actualQuantity, issues: scoped };
  });
  return { results, issues };
}

export function quantityScenarioTexts(c: QuantityContract, checks: QuantityCheck[]): string[] {
  return quantityStates(c).map(s => {
    const check = checks.find(check => check.caseId === s.caseId)!;
    return `Quantity ${s.quantity}, stock ${s.stock === null ? 'null (unknown)' : s.stock}, product unavailable=${s.productUnavailable}: ${check.action} ${c.direction} by ${c.step}; enabled=${check.expectedEnabled}; expect quantity ${check.expectedQuantity} (minimum ${c.minimum}).`;
  });
}

export function quantityRuleText(r: QuantityRule): string {
  return `Structured quantity rule: ${r.operation} ${r.step}; bound=${r.bound}, minimum=${r.minimum}, guard=${r.guard}. Use explicit null checks for unknown stock; disabled actions leave quantity unchanged.`;
}
