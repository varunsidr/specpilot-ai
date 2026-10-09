import type { AIProvider, Requirement, RepositoryContext, Plan, ContextRequest, Evidence } from '../types.ts';
import { rangeSupplied } from '../repositories/ranges.ts';
import { validatePlan } from './schema.ts';
import { assessmentPlan, assessmentSchema, draftPlan, draftSchema, reviewSchema, validateReview, type AssessmentResponse, type DraftResponse, type ReviewResponse } from './stages.ts';
import { MAX_CONTEXT_ROUNDS, MAX_PLAN_TOKENS, PROMPT_SAFETY_TOKENS, messageTokens, stageMessages, type Stage } from './prompt.ts';
import type { TokenCounter } from '../repositories/tokenizer.ts';
export type OllamaMetrics = { promptTokens?: number; generatedTokens?: number; totalDurationMs?: number; loadDurationMs?: number; doneReason?: string; requests: number; contextRounds: number; validationFailures: string[];
  stages: { stage: Stage; promptTokens?: number; generatedTokens?: number; estimatedPromptTokens: number; durationMs: number }[]; assessment?: AssessmentResponse; draft?: DraftResponse; review?: ReviewResponse; reviewAttempts: { draft: DraftResponse; review: ReviewResponse }[]; consistencyFailures: string[]; redundantContextRequests: ContextRequest[]; rejectedResponses: { stage: Stage; error: string; content: string; truncated: boolean }[] };
export class OllamaProvider implements AIProvider {
  name = 'ollama';
  lastMetrics?: OllamaMetrics;
  private options: { url: string; model: string; timeoutMs: number; numCtx: number; tokenCounter: TokenCounter };
  constructor(options: { url: string; model: string; timeoutMs: number; numCtx: number; tokenCounter: TokenCounter }) { this.options = options; }
  async plan(requirement: Requirement, context: RepositoryContext, options?: { resolveContext?: (requests: ContextRequest[], retainEvidence: Evidence[]) => Promise<RepositoryContext> }): Promise<Plan> {
    this.lastMetrics = { requests: 0, contextRounds: 0, validationFailures: [], stages: [], consistencyFailures: [], reviewAttempts: [], redundantContextRequests: [], rejectedResponses: [] };
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    const requestStage = async <T>(stage: Stage, schema: object, validate: (value: unknown) => T, assessment?: AssessmentResponse, draft?: DraftResponse, initialFeedback?: string): Promise<T> => {
      let feedback = initialFeedback;
      for (let attempt = 0; attempt < 2; attempt++) {
        const messages = stageMessages(stage, requirement, context, feedback, assessment, draft);
        const estimatedPromptTokens = messageTokens(this.options.tokenCounter, messages);
        if (estimatedPromptTokens + MAX_PLAN_TOKENS + PROMPT_SAFETY_TOKENS > this.options.numCtx) throw new Error(`${stage} prompt exceeds ${this.options.numCtx}-token context; reduce requirement or pinned evidence`);
        const response = await fetch(new URL('/api/chat', this.options.url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({
            model: this.options.model, stream: false, think: false, format: schema,
            options: { temperature: 0, num_ctx: this.options.numCtx, num_predict: MAX_PLAN_TOKENS },
            messages,
          }),
        });
        if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}. Check ollama list, the model name and whether Ollama is running.`);
        const body = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; total_duration?: number; load_duration?: number; done_reason?: string };
        this.lastMetrics!.requests++;
        this.lastMetrics!.stages.push({ stage, estimatedPromptTokens, promptTokens: body.prompt_eval_count, generatedTokens: body.eval_count, durationMs: Math.round((body.total_duration ?? 0) / 1e6) });
        Object.assign(this.lastMetrics!, { promptTokens: body.prompt_eval_count, generatedTokens: body.eval_count, totalDurationMs: (this.lastMetrics!.totalDurationMs ?? 0) + Math.round((body.total_duration ?? 0) / 1e6), loadDurationMs: (this.lastMetrics!.loadDurationMs ?? 0) + Math.round((body.load_duration ?? 0) / 1e6), doneReason: body.done_reason });
        try {
          if (!body.message?.content) throw new Error('Ollama returned no plan content');
          return validate(JSON.parse(body.message.content));
        } catch (error) {
          feedback = error instanceof Error ? error.message : 'invalid response';
          this.lastMetrics!.validationFailures.push(`${stage}: ${feedback}`);
          const content = body.message?.content ?? '';
          this.lastMetrics!.rejectedResponses.push({ stage, error: feedback, content: content.slice(0, 12000), truncated: content.length > 12000 });
          if (attempt === 1) throw error;
        }
      }
      throw new Error(`Ollama did not produce a valid ${stage}`);
    };
    let followUpFeedback: string | undefined;
    let redundantReassessed = false;
    for (let round = 0; round <= MAX_CONTEXT_ROUNDS; round++) {
      const assessed = await requestStage('assessment', assessmentSchema(context, requirement), value => assessmentPlan(value, context, requirement), this.lastMetrics.assessment, undefined, followUpFeedback);
      followUpFeedback = undefined;
      this.lastMetrics.assessment = assessed.response;
      this.lastMetrics.redundantContextRequests.push(...assessed.redundantRequests);
      const base = assessed.plan;
      if (base.outcome === 'changes_needed') {
        let revisionFeedback: string | undefined;
        for (let revision = 0; revision < 2; revision++) {
          const drafted = await requestStage('draft', draftSchema(context, requirement, base), value => draftPlan(value, assessed.response, base, context, requirement), assessed.response, undefined, revisionFeedback);
          this.lastMetrics.draft = drafted.response;
          const review = await requestStage('review', reviewSchema(requirement, base, drafted.response), value => validateReview(value, base, requirement, drafted.response), assessed.response, drafted.response);
          this.lastMetrics.review = review;
          this.lastMetrics.reviewAttempts.push({ draft: drafted.response, review });
          const issues = [...review.checks.flatMap(check => {
            const failed = check.scenarioChecks.filter(scenario => !scenario.executable || !scenario.resultMatches);
            const findings = check.issues.map(issue => `Criterion ${check.criterion}: ${issue}`);
            if (check.stepsMatchTests !== (failed.length === 0)) findings.push(`Criterion ${check.criterion}: Reviewer summary contradicts its scenario checks.`);
            for (const scenario of failed) findings.push(`Criterion ${check.criterion}: ${!scenario.executable ? 'Required scenario action is blocked' : 'Scenario result does not match'}. ${scenario.observation}`);
            return findings;
          }), ...review.riskIssues.map(finding => `Risk "${finding.risk}": ${finding.issue}`)];
          this.lastMetrics.consistencyFailures.push(...issues);
          if (!issues.length) return validatePlan(drafted.plan, context, requirement);
          if (revision === 1) throw new Error(`Plan consistency review rejected draft: ${issues.join('; ').slice(0, 1000)}`);
          revisionFeedback = `The previous draft was rejected by consistency review. Redraft the locked gaps from source, correcting these findings: ${issues.join('; ')}`;
        }
      }
      if (!base.contextRequests.length || !options?.resolveContext || round === MAX_CONTEXT_ROUNDS) return base;
      const redundant = base.contextRequests.every(request => rangeSupplied(context, request));
      context = await options.resolveContext(base.contextRequests, base.assessments.flatMap(a => a.evidence));
      this.lastMetrics.contextRounds++;
      if (!context.followUps?.at(-1)?.served.length) {
        if (redundant && !redundantReassessed) {
          redundantReassessed = true;
          followUpFeedback = 'Your requested ranges are already supplied. Reassess from those lines and suppliedRanges: compare current behavior with the criterion. Do not request the same evidence again. Keep unknown only for a specific unresolved source fact or business decision; do not guess.';
        } else return validatePlan(base, context, requirement);
      }
    }
    throw new Error('Ollama did not produce a valid plan');
  }
}
