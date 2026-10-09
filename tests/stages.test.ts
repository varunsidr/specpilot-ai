import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { evidenceCatalog, resolveEvidence } from '../src/providers/evidence.ts';
import { assessmentPlan, assessmentSchema, draftPlan, draftSchema, reviewSchema, validateReview } from '../src/providers/stages.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { context, requirement, gapPlan, assessmentResponse, draftResponse, positiveReview, tokenCounter } from './plan-fixtures.ts';

test('evidence IDs survive overlapping excerpts and reject stale source', () => {
  const original = evidenceCatalog(context);
  const duplicated = evidenceCatalog({ ...context, files: [...context.files, ...context.files] });
  assert.deepEqual([...duplicated], [...original]);
  const changed = evidenceCatalog({ ...context, files: [{ ...context.files[0], content: 'export const price = 20;' }] });
  assert.throws(() => resolveEvidence([...original.keys()], changed, true), /Unknown evidence ID/);
  const citation = resolveEvidence([...original.keys()], original, true)[0];
  assert.equal(citation.quote, 'export const price = 10;');
  assert.equal(citation.startLine, 1);
  const moved = evidenceCatalog({ ...context, files: [{ ...context.files[0], startLine: 2, endLine: 2 }] });
  assert.notEqual([...moved.keys()][0], [...original.keys()][0]);
});

test('stage schemas constrain criteria counts, ownership and exact review scenarios', () => {
  const one = assessmentSchema(context, requirement).properties.assessments;
  assert.equal(one.minItems, 1); assert.equal(one.maxItems, 1);
  assert.ok('anyOf' in one.items);
  if (!('anyOf' in one.items)) throw new Error('Expected status-specific alternatives');
  assert.equal(one.items.anyOf[0].properties.criterion.const, 1);
  assert.equal(one.items.anyOf[0].properties.evidenceIds.minItems, 1);
  assert.equal(one.items.anyOf[1].properties.evidenceIds.minItems, 0);
  const base = assessmentPlan(assessmentResponse(), context, requirement).plan;
  const draft = draftSchema(context, requirement, base).properties.criteria;
  assert.equal(draft.minItems, 1); assert.equal(draft.maxItems, 1);
  const review = reviewSchema(requirement, base, draftResponse()).properties.checks;
  assert.equal(review.minItems, 1); assert.equal(review.maxItems, 1);
  const variant = review.items as { properties: { scenarioChecks: { minItems: number; maxItems: number; items: { properties: { scenario: { enum: string[] } } } } } };
  assert.equal(variant.properties.scenarioChecks.minItems, 1);
  assert.deepEqual(variant.properties.scenarioChecks.items.properties.scenario.enum, gapPlan().testScenarios);
});

test('long source lines use bounded fragments with exact provenance', () => {
  const raw = 'const value = "' + 'x'.repeat(1100) + '";';
  const catalog = evidenceCatalog({ files: [{ ...context.files[0], content: raw }], warnings: [] });
  assert.equal(catalog.size, 3);
  for (const citation of catalog.values()) {
    assert.ok(citation.quote.length <= 500);
    assert.ok(raw.includes(citation.quote));
    assert.equal(citation.startLine, citation.endLine);
  }
});

test('assessment rejects unknown IDs, copied quotes, and swapped criterion text', () => {
  const invalid = assessmentResponse(); invalid.assessments[0].evidenceIds = ['invented'];
  assert.throws(() => assessmentPlan(invalid, context, requirement), /Unknown evidence ID/);
  const wrongText = assessmentResponse(); wrongText.assessments[0].criterionText = 'A different requirement';
  assert.throws(() => assessmentPlan(wrongText, context, requirement), /exactly match/);
  assert.throws(() => assessmentPlan({ ...assessmentResponse(), changes: gapPlan().changes }, context, requirement), /Invalid stage fields/);
});

test('unresolved assessment questions prevent locking a gap for drafting', async () => {
  const unresolved = assessmentResponse(); unresolved.questions = ['Which boundary policy did the business agree?'];
  assert.throws(() => assessmentPlan(unresolved, context, requirement), /questions require unknown criteria/);
  const unknown = structuredClone(unresolved); unknown.assessments[0].status = 'unknown';
  await withProvider((body, call) => {
    assert.ok(call <= 2);
    if (call === 2) assert.match(body.messages[1].content, /business decisions must be unknown/);
    return call === 1 ? unresolved : unknown;
  }, async provider => {
    const plan = await provider.plan(requirement, context);
    assert.equal(plan.outcome, 'needs_context');
    assert.deepEqual(plan.changes, []);
    assert.deepEqual(provider.lastMetrics?.stages.map(stage => stage.stage), ['assessment', 'assessment']);
  });
});

test('resolved assessments discard only supplied requests without changing evidence or status', () => {
  const response = assessmentResponse();
  response.contextRequests = [{ repository: 'website', path: 'products.ts', startLine: 1, endLine: 1, reason: 'Read the current price' }];
  const result = assessmentPlan(response, context, requirement);
  assert.equal(result.plan.outcome, 'changes_needed');
  assert.deepEqual(result.plan.contextRequests, []);
  assert.deepEqual(result.response.contextRequests, []);
  assert.deepEqual(result.redundantRequests, response.contextRequests);
  assert.deepEqual(result.plan.assessments[0].evidence, gapPlan().assessments[0].evidence);
  response.contextRequests[0].endLine = 2;
  assert.throws(() => assessmentPlan(response, context, requirement), /Resolved assessments cannot have pending/);
});

test('draft keeps assessment fixed and requires exact criterion ownership', () => {
  const assessed = assessmentPlan(assessmentResponse(), context, requirement);
  const wrong = draftResponse(); wrong.criteria[0].criterion = 2;
  assert.throws(() => draftPlan(wrong, assessed.response, assessed.plan, context, requirement), /stage criterion/);
  const copiedText = draftResponse(); copiedText.criteria[0].criterionText = 'Decrease instead of increase';
  assert.throws(() => draftPlan(copiedText, assessed.response, assessed.plan, context, requirement), /exactly match/);
  assert.throws(() => draftPlan({ ...draftResponse(), assessments: [] }, assessed.response, assessed.plan, context, requirement), /Invalid stage fields/);
  assert.deepEqual(draftPlan(draftResponse(), assessed.response, assessed.plan, context, requirement).plan.assessments, assessed.plan.assessments);
});

test('review cannot approve while reporting issues or omit a criterion', () => {
  const base = assessmentPlan(assessmentResponse(), context, requirement).plan;
  const inconsistent = positiveReview(); inconsistent.checks[0].issues = ['Disabled button cannot clamp'];
  assert.throws(() => validateReview(inconsistent, base, requirement, draftResponse()), /flags and issues/);
  assert.throws(() => validateReview({ checks: [], riskIssues: [] }, base, requirement, draftResponse()), /every required criterion/);
  const missingScenario = positiveReview(); missingScenario.checks[0].scenarioChecks = [];
  assert.throws(() => validateReview(missingScenario, base, requirement, draftResponse()), /every draft test scenario/);
});

test('risk review rejects invented findings and binds real findings to the draft', () => {
  const base = assessmentPlan(assessmentResponse(), context, requirement).plan;
  const draft = draftResponse();
  const empty = positiveReview();
  assert.equal(reviewSchema(requirement, base, draft).properties.riskIssues.maxItems, 0);
  assert.throws(() => validateReview({ ...empty, riskIssues: ['No risk issues identified.'] }, base, requirement, draft), /actual draft risks/);
  draft.risks = ['Local filtering can corrupt server inventory.'];
  const finding = { risk: draft.risks[0], issue: 'The cited fixed price does not establish server inventory writes.' };
  assert.deepEqual(validateReview({ ...empty, riskIssues: [finding] }, base, requirement, draft).riskIssues, [finding]);
  assert.throws(() => validateReview({ ...empty, riskIssues: [{ ...finding, risk: 'An invented risk' }] }, base, requirement, draft), /actual draft risk/);
  draft.risks.push('Another draft risk');
  assert.throws(() => validateReview({ ...empty, riskIssues: [finding, finding] }, base, requirement, draft), /at most once/);
});

async function withProvider(respond: (body: any, call: number) => unknown, work: (provider: OllamaProvider) => Promise<void>, counter = tokenCounter) {
  let call = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const output = respond(JSON.parse(raw), ++call);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify(output) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await work(new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test', timeoutMs: 5000, numCtx: 8192, tokenCounter: counter })); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('implemented criteria finish after assessment without draft or review calls', async () => {
  const result = assessmentResponse(); result.assessments[0].status = 'implemented';
  await withProvider((_body, call) => { assert.equal(call, 1); return result; }, async provider => {
    const plan = await provider.plan(requirement, context);
    assert.equal(plan.outcome, 'already_implemented'); assert.deepEqual(plan.changes, []);
    assert.deepEqual(provider.lastMetrics?.stages.map(s => s.stage), ['assessment']);
    assert.equal(plan.assessments[0].evidence[0].quote, context.files[0].content);
  });
});

test('detected step/test contradictions reject the draft and preserve review findings', async () => {
  const review = positiveReview(); review.checks[0].stepsMatchTests = false; review.checks[0].issues = ['A disabled control cannot be clicked to clamp the boundary.'];
  review.checks[0].scenarioChecks[0].executable = false;
  await withProvider((_body, call) => call === 1 ? assessmentResponse() : call === 2 || call === 4 ? draftResponse() : review, async provider => {
    await assert.rejects(provider.plan(requirement, context), /consistency review rejected draft/);
    assert.equal(provider.lastMetrics?.requests, 5);
    assert.equal(provider.lastMetrics?.consistencyFailures.length, 4);
    assert.equal(provider.lastMetrics?.reviewAttempts.length, 2);
    assert.equal(provider.lastMetrics?.review?.checks[0].stepsMatchTests, false);
  });
});

test('a review-guided correction is reviewed again before acceptance', async () => {
  const negative = positiveReview(); negative.checks[0].stepsMatchTests = false;
  negative.checks[0].scenarioChecks[0].resultMatches = false;
  negative.checks[0].issues = ['The boundary comparison excludes equal prices.'];
  await withProvider((body, call) => {
    if (call === 1) return assessmentResponse();
    if (call === 3) return negative;
    if (call === 5) return positiveReview();
    if (call === 4) assert.match(body.messages[1].content, /boundary comparison excludes equal prices/);
    return draftResponse();
  }, async provider => {
    const result = await provider.plan(requirement, context);
    assert.equal(result.outcome, 'changes_needed');
    assert.deepEqual(result.assessments, gapPlan().assessments);
    assert.equal(provider.lastMetrics?.reviewAttempts.length, 2);
    assert.equal(provider.lastMetrics?.review?.checks[0].stepsMatchTests, true);
    assert.equal(provider.lastMetrics?.consistencyFailures.length, 2);
  });
});

test('failed scenario checks force correction even when the reviewer summary approves', async () => {
  const contradictory = positiveReview();
  contradictory.checks[0].scenarioChecks[0].executable = false;
  contradictory.checks[0].scenarioChecks[0].observation = 'The proposed disabled guard blocks the required boundary action.';
  await withProvider((body, call) => {
    if (call === 1) return assessmentResponse();
    if (call === 3) return contradictory;
    if (call === 4) assert.match(body.messages[1].content, /disabled guard blocks/);
    return call === 5 ? positiveReview() : draftResponse();
  }, async provider => {
    const plan = await provider.plan(requirement, context);
    assert.equal(plan.outcome, 'changes_needed');
    assert.equal(provider.lastMetrics?.requests, 5);
    assert.deepEqual(provider.lastMetrics?.validationFailures, []);
    assert.equal(provider.lastMetrics?.reviewAttempts.length, 2);
    assert.equal(provider.lastMetrics?.reviewAttempts[0].review.checks[0].stepsMatchTests, true);
    assert.match(provider.lastMetrics!.consistencyFailures.join('\n'), /Reviewer summary contradicts/);
  });
});

test('repeated failed scenarios cannot be accepted through positive summary flags', async () => {
  const contradictory = positiveReview(); contradictory.checks[0].scenarioChecks[0].resultMatches = false;
  await withProvider((_body, call) => call === 1 ? assessmentResponse() : call === 2 || call === 4 ? draftResponse() : contradictory, async provider => {
    await assert.rejects(provider.plan(requirement, context), /consistency review rejected draft/);
    assert.equal(provider.lastMetrics?.requests, 5);
    assert.equal(provider.lastMetrics?.reviewAttempts.length, 2);
    assert.deepEqual(provider.lastMetrics?.validationFailures, []);
  });
});

test('unsupported draft risks trigger a correction with the specific risk finding', async () => {
  const initialDraft = draftResponse(); initialDraft.risks = ['Local filtering can corrupt server inventory.'];
  const review = positiveReview();
  review.riskIssues = [{ risk: initialDraft.risks[0], issue: 'No server inventory write is supported by the cited code.' }];
  await withProvider((body, call) => {
    if (call === 1) return assessmentResponse();
    if (call === 2) return initialDraft;
    if (call === 3) return review;
    if (call === 4) {
      assert.match(body.messages[1].content, /No server inventory write/);
      return draftResponse();
    }
    return positiveReview();
  }, async provider => {
    const plan = await provider.plan(requirement, context);
    assert.deepEqual(plan.risks, []);
    assert.equal(provider.lastMetrics?.reviewAttempts.length, 2);
    assert.match(provider.lastMetrics!.consistencyFailures[0], /Risk "Local filtering can corrupt server inventory/);
  });
});

test('every stage checks actual token fit before sending its request', async () => {
  await withProvider((_body, call) => { assert.equal(call, 1); return assessmentResponse(); }, async provider => {
    await assert.rejects(provider.plan(requirement, context), /draft prompt exceeds/);
    assert.equal(provider.lastMetrics?.requests, 1);
  }, { model: 'test', count: value => value.includes('lockedAssessment') ? 9000 : 100 });
});

test('already supplied requests get one reassessment with feedback before drafting', async () => {
  const unknown = assessmentResponse();
  unknown.assessments[0].status = 'unknown';
  unknown.questions = ['What is the current boundary behavior?'];
  unknown.contextRequests = [{ repository: 'website', path: 'products.ts', startLine: 1, endLine: 1, reason: 'Read current behavior' }];
  await withProvider((body, call) => {
    if (call === 1) return unknown;
    if (call === 2) {
      const input = JSON.parse(body.messages[1].content);
      assert.match(input.validationFeedback, /already supplied/);
      assert.deepEqual(input.previousAssessment, unknown);
      assert.match(JSON.stringify(input.context.contextFollowUps), /already supplied/);
      assert.equal(input.context.suppliedRanges[0].startLine, 1);
      return assessmentResponse();
    }
    return call === 3 ? draftResponse() : positiveReview();
  }, async provider => {
    const result = await provider.plan(requirement, context, { resolveContext: async (requests, retainEvidence) => {
      assert.equal(retainEvidence[0].quote, context.files[0].content);
      return { ...context, followUps: [{ requests, served: [], warnings: ['products.ts:1-1: already supplied'] }] };
    } });
    assert.equal(result.outcome, 'changes_needed');
    assert.deepEqual(provider.lastMetrics?.stages.map(s => s.stage), ['assessment', 'assessment', 'draft', 'review']);
  });
});

test('repeated redundant requests stop without forcing unknown criteria into gaps', async () => {
  const unknown = assessmentResponse(); unknown.assessments[0].status = 'unknown';
  unknown.questions = ['An unresolved policy decision is needed.'];
  unknown.contextRequests = [{ repository: 'website', path: 'products.ts', startLine: 1, endLine: 1, reason: 'Read the same code' }];
  let current = structuredClone(context);
  await withProvider((_body, call) => { assert.ok(call <= 2); return unknown; }, async provider => {
    const result = await provider.plan(requirement, current, { resolveContext: async requests => {
      current = { ...current, followUps: [...(current.followUps ?? []), { requests, served: [], warnings: ['already supplied'] }] };
      return current;
    } });
    assert.equal(result.outcome, 'needs_context');
    assert.equal(result.changes.length, 0);
    assert.equal(provider.lastMetrics?.requests, 2);
  });
});
