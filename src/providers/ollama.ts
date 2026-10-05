import type { AIProvider, Requirement, RepositoryContext, Plan } from '../types.ts';
import { planSchema, validatePlan } from './schema.ts';
import { MAX_PLAN_TOKENS, planMessages } from './prompt.ts';
export type OllamaMetrics = { promptTokens?: number; generatedTokens?: number; totalDurationMs?: number; loadDurationMs?: number; doneReason?: string };
export class OllamaProvider implements AIProvider {
  name = 'ollama';
  lastMetrics?: OllamaMetrics;
  private options: { url: string; model: string; timeoutMs: number; numCtx: number };
  constructor(options: { url: string; model: string; timeoutMs: number; numCtx: number }) { this.options = options; }
  async plan(requirement: Requirement, context: RepositoryContext): Promise<Plan> {
    this.lastMetrics = undefined;
    const allowed = [...new Set(context.files.map(file => `${file.repository}:${file.path}`))];
    const messages = planMessages(requirement, context);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(new URL('/api/chat', this.options.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(this.options.timeoutMs),
        body: JSON.stringify({
          model: this.options.model, stream: false, think: false, format: planSchema,
          options: { temperature: 0, num_ctx: this.options.numCtx, num_predict: MAX_PLAN_TOKENS },
          messages,
        }),
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}. Check ollama list, the model name and whether Ollama is running.`);
      const body = await response.json() as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; total_duration?: number; load_duration?: number; done_reason?: string };
      this.lastMetrics = { promptTokens: body.prompt_eval_count, generatedTokens: body.eval_count, totalDurationMs: body.total_duration ? Math.round(body.total_duration / 1e6) : undefined, loadDurationMs: body.load_duration ? Math.round(body.load_duration / 1e6) : undefined, doneReason: body.done_reason };
      try {
        if (!body.message?.content) throw new Error('Ollama returned no plan content');
        return validatePlan(JSON.parse(body.message.content), context);
      } catch (error) {
        if (attempt === 1) throw error;
        messages.push({ role: 'assistant', content: body.message?.content ?? '' });
        messages.push({ role: 'user', content: `Your plan was rejected: ${error instanceof Error ? error.message : 'invalid response'}. Regenerate the complete JSON plan. Changes may use only these exact repository/path pairs: ${JSON.stringify(allowed)}. Put proposed new files in questions.` });
      }
    }
    throw new Error('Ollama did not produce a valid plan');
  }
}
