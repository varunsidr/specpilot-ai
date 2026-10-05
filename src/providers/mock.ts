import type { AIProvider, Requirement, RepositoryContext, Plan } from '../types.ts';
export class MockProvider implements AIProvider {
  name = 'mock';
  async plan(requirement: Requirement, context: RepositoryContext): Promise<Plan> {
    return {
      summary: `MOCK ONLY: demonstrate the planning flow for “${requirement.title}”. No AI analysis was performed.`,
      changes: context.files.slice(0, 2).map(f => ({ repository: f.repository, path: f.path, reason: 'Example reference from retrieved context; relevance requires review.', steps: ['Review this file against the requirement before making changes.'] })),
      testScenarios: requirement.acceptanceCriteria.map(c => `Verify: ${c}`),
      risks: ['This deterministic sample is not an implementation recommendation.'],
      questions: ['Switch AI_PROVIDER to ollama for actual model analysis.'],
    };
  }
}
