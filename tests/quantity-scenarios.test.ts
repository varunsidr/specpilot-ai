import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateRequirement } from '../src/requirements/validate.ts';
import { quantityOutcome, quantityStates, checkQuantityScenarios, validateQuantityFields, type QuantityRule, type QuantityCheck } from '../src/providers/quantity-scenarios.ts';
import { draftPlan, draftSchema, reviewSchema, validateReview, type DraftResponse, type ReviewResponse } from '../src/providers/stages.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { stageMessages } from '../src/providers/prompt.ts';
import type { QuantityContract, Requirement } from '../src/types.ts';
import { gapPlan, context, requirement, assessmentResponse, draftResponse, tokenCounter } from './plan-fixtures.ts';

const increase: QuantityContract = { kind: 'quantity_step', criterion: 1, direction: 'increase', step: 5, minimum: 1 };
const decrease: QuantityContract = { ...increase, direction: 'decrease' };
const plus: QuantityRule = { operation: 'add', bound: 'stock', guard: 'stock_or_unavailable', step: 5, minimum: 1 };
const minus: QuantityRule = { operation: 'subtract', bound: 'minimum', guard: 'at_minimum', step: 5, minimum: 1 };
const contracted: Requirement = { ...requirement, acceptanceCriteria: ['Increase by five, clamping to known stock and preserving the minimum.'], scenarioContracts: [increase] };
const base = { ...gapPlan(), testScenarios: [] };
function checks(c = increase): QuantityCheck[] {
  // Independent expected results for the backend's default synthetic states.
  const expected = c.direction === 'increase' ? [6, 7, 11, 1, 11, 1] : [6, 1, 1, 1, 1, 1];
  const enabled = c.direction === 'increase' ? [true, true, false, false, true, false] : [true, true, false, true, false, true];
  return quantityStates(c).map((state, i) => ({ caseId: state.caseId, action: enabled[i] ? 'click' : 'assert_disabled', expectedEnabled: enabled[i], expectedQuantity: expected[i] }));
}
function draft(): DraftResponse {
  const d = draftResponse();
  d.criteria[0] = { ...d.criteria[0], criterionText: contracted.acceptanceCriteria[0], testScenarios: [], quantityRule: { ...plus }, quantityChecks: checks() };
  return d;
}

test('quantity contracts validate caller-owned bounds and preserve existing requirements', () => {
  assert.deepEqual(validateRequirement(requirement), requirement);
  assert.deepEqual(validateRequirement(contracted), contracted);
  for (const change of [{ kind: 'code' }, { criterion: 0 }, { criterion: 2 }, { step: 0 }, { step: 1.5 }, { step: Infinity }, { minimum: 0 }, { minimum: 999999 }, { direction: 'multiply' }, { extra: true }]) {
    assert.throws(() => validateRequirement({ ...contracted, scenarioContracts: [{ ...increase, ...change }] }));
  }
  assert.throws(() => validateRequirement({ ...contracted, acceptanceCriteria: ['a', 'b'], scenarioContracts: [increase, increase] }));
});

test('quantity arithmetic matches the source-reviewed numeric/guard reference', () => {
  const cases: [QuantityContract, QuantityRule, number, number | null, boolean, boolean, number][] = [
    [increase, plus, 3, 10, false, true, 8], [increase, plus, 8, 10, false, true, 10],
    [increase, plus, 10, 10, false, false, 10], [increase, plus, 1, 0, false, false, 1],
    [increase, plus, 3, null, false, true, 8], [increase, plus, 3, null, true, false, 3],
    [decrease, minus, 8, 10, false, true, 3], [decrease, minus, 5, 10, false, true, 1],
    [decrease, minus, 2, 10, false, true, 1], [decrease, minus, 1, 10, false, false, 1],
    [decrease, minus, 1, null, false, false, 1], [decrease, { ...minus, guard: 'never' }, 1, null, false, true, 1],
  ];
  for (const [contract, rule, quantity, stock, productUnavailable, expectedEnabled, expectedQuantity] of cases) {
    const result = quantityOutcome(contract, rule, { caseId: 'reference', quantity, stock, productUnavailable });
    assert.deepEqual(result, { requiredEnabled: expectedEnabled, actualEnabled: expectedEnabled, requiredQuantity: expectedQuantity, actualQuantity: expectedQuantity });
  }
});

test('deterministic checks reject raw arithmetic, partial-step guards, disabled clicks and skipped actions', () => {
  assert.deepEqual(checkQuantityScenarios(increase, plus, checks()).issues, []);
  assert.deepEqual(checkQuantityScenarios(decrease, minus, checks(decrease)).issues, []);
  for (const rule of [{ ...plus, bound: 'none' as const }, { ...plus, guard: 'full_step_or_unavailable' as const }, { ...plus, guard: 'never' as const }, { ...plus, operation: 'subtract' as const }, { ...plus, step: 3 }]) {
    assert.ok(checkQuantityScenarios(increase, rule, checks()).issues.length);
  }
  const disabledClick = checks(); disabledClick.find(c => c.caseId === 'limit')!.action = 'click';
  assert.match(checkQuantityScenarios(increase, plus, disabledClick).issues.join(' '), /click is disabled/);
  const skipped = checks(); skipped[0].action = 'assert_unchanged';
  assert.match(checkQuantityScenarios(increase, plus, skipped).issues.join(' '), /skips the required action/);
  const zero = checks(decrease); zero.find(c => c.caseId === 'partial')!.expectedQuantity = 0;
  validateQuantityFields(minus, zero, decrease); // Numeric errors belong to bounded correction, not schema repair.
  assert.match(checkQuantityScenarios(decrease, minus, zero).issues.join(' '), /expectation 0/);
  assert.ok(checkQuantityScenarios(decrease, { ...minus, guard: 'known_stock_at_minimum' }, checks(decrease)).issues.some(s => s.includes('unknown_minimum')));
});

test('quantity rules support other steps/minima and both permitted decrease-at-minimum choices', () => {
  const c: QuantityContract = { ...decrease, step: 3, minimum: 2 };
  assert.equal(quantityOutcome(c, { ...minus, step: 3, minimum: 2 }, { caseId: 'partial', quantity: 4, stock: null, productUnavailable: true }).actualQuantity, 2);
  const clampChecks = checks(decrease).map(c => c.caseId === 'minimum' || c.caseId === 'unknown_minimum' ? { ...c, action: 'click' as const, expectedEnabled: true } : c);
  assert.deepEqual(checkQuantityScenarios(decrease, { ...minus, guard: 'never' }, clampChecks).issues, []);
  const single: QuantityContract = { ...increase, step: 1 };
  assert.ok(!quantityStates(single).some(s => s.caseId === 'partial'), 'integer step one has no smaller positive partial step');
});

test('structured scenarios cannot omit boundaries, inject state/code, or replace canonical public expectations', () => {
  const missing = checks().slice(1);
  assert.throws(() => validateQuantityFields(plus, missing, increase), /every backend/);
  const duplicate = checks(); duplicate[1] = duplicate[0];
  assert.throws(() => validateQuantityFields(plus, duplicate, increase), /duplicate/);
  const injected = checks().map(c => ({ ...c, startQuantity: 0 }));
  assert.throws(() => validateQuantityFields(plus, injected, increase), /structured quantity fields/);
  const narrative = draft(); narrative.criteria[0].testScenarios = ['Wrong: 8 plus 5 becomes 13 despite stock 10.'];
  const assessed = assessmentResponse(base, context, contracted);
  assert.throws(() => draftPlan(narrative, assessed, base, context, contracted), /testScenarios=\[\]/);
  const schema = draftSchema(context, contracted, base).properties.criteria.items;
  assert.ok('properties' in schema);
  if ('properties' in schema) assert.ok('quantityRule' in schema.properties);
  const normalized = draftPlan(draft(), assessed, base, context, contracted);
  assert.equal(normalized.plan.schemaVersion, 2);
  assert.equal(normalized.plan.testScenarios.length, 6);
  assert.match(normalized.plan.testScenarios[1], /Quantity 6, stock 7.*expect quantity 7/);
  assert.match(normalized.plan.changes[0].steps[0], /Structured quantity rule/);
  assert.equal(normalized.response.criteria[0].testScenarios.length, 6);
  const review = reviewSchema(contracted, base, normalized.response).properties.checks.items;
  assert.ok('properties' in review && review.properties.scenarioChecks.minItems === 6);
  assert.ok(JSON.parse(stageMessages('draft', contracted, context, undefined, assessed)[1].content).requirement.scenarioContracts[0].cases.length === 6);
});

test('backend rejects a bad draft before model review, permits one correction, and retains both results', async () => {
  for (const [correctOnRetry, rejectReview] of [[true, false], [false, false], [true, true]]) {
    let call = 0;
    const assessed = assessmentResponse(base, context, contracted);
    const wrong = draft(); wrong.criteria[0].quantityRule!.bound = 'none'; wrong.criteria[0].quantityChecks![1].expectedQuantity = 11;
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw), input = JSON.parse(body.messages[1].content);
      call++;
      let output: unknown;
      if (call === 1) output = assessed;
      else if (call === 2) output = wrong;
      else if (call === 3) { assert.match(input.validationFeedback, /Backend quantity checks rejected/); output = correctOnRetry ? draft() : wrong; }
      else {
        assert.equal(call, 4, 'bad arithmetic must never be sent to model review');
        const scenarios = input.proposedDraft.criteria[0].testScenarios as string[];
        const review: ReviewResponse = { checks: [{ criterion: 1, criterionText: contracted.acceptanceCriteria[0], criterionAligned: !rejectReview, stepsMatchTests: true, evidenceSupportsGap: true,
          scenarioChecks: scenarios.map(scenario => ({ scenario, executable: true, resultMatches: true, observation: 'The declared rule and controlled fixture agree.' })), issues: rejectReview ? ['Implementation prose contradicts the declared rule.'] : [] }], riskIssues: [] };
        validateReview(review, base, contracted, input.proposedDraft);
        output = review;
      }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ message: { content: JSON.stringify(output) } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test', timeoutMs: 5000, numCtx: 8192, tokenCounter });
      if (correctOnRetry && !rejectReview) {
        const result = await provider.plan(contracted, context);
        assert.equal(result.outcome, 'changes_needed'); assert.equal(provider.lastMetrics!.reviewAttempts.length, 1);
      } else {
        await assert.rejects(provider.plan(contracted, context), rejectReview ? /consistency review rejected/ : /Deterministic quantity checks rejected/);
        assert.equal(call, rejectReview ? 4 : 3); assert.equal(provider.lastMetrics!.reviewAttempts.length, rejectReview ? 1 : 0);
      }
      assert.equal(provider.lastMetrics!.scenarioAttempts.length, 2);
      assert.ok(provider.lastMetrics!.scenarioAttempts[0].issues.length);
      assert.deepEqual(provider.lastMetrics!.validationFailures, []);
      assert.equal(provider.lastMetrics!.scenarioAttempts[1].issues.length === 0, correctOnRetry);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});
