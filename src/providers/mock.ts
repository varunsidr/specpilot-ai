import type { AIProvider, Requirement, RepositoryContext, Plan } from '../types.ts';
export class MockProvider implements AIProvider {
  name = 'mock';
  async plan(requirement: Requirement, context: RepositoryContext): Promise<Plan> {
    return {
      schemaVersion: 2, outcome: 'needs_context',
      summary: `MOCK ONLY: demonstrate the planning flow for “${requirement.title}”. No AI analysis was performed.`,
      changes: [], contextRequests: [],
      assessments: requirement.acceptanceCriteria.map((_, i) => ({ criterion: i + 1, status: 'unknown', observation: 'Mock mode does not assess code.', evidence: [] })),
      testScenarios: requirement.acceptanceCriteria.map(c => `Verify: ${c}`),
      risks: ['This deterministic sample is not an implementation recommendation.'],
      questions: ['Switch AI_PROVIDER to ollama for actual model analysis.'],
    };
  }
}
