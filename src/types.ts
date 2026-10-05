export type RepositoryName = 'website' | 'tests';
export type PinnedFile = { repository: RepositoryName; path: string };
export type Requirement = { title: string; description: string; acceptanceCriteria: string[]; pinnedFiles?: PinnedFile[] };
export type ContextFile = { repository: RepositoryName; path: string; content: string; truncated: boolean; startLine?: number; endLine?: number; reason?: 'pinned' | 'semantic' | 'import' | 'test' };
export type RepositoryContext = { files: ContextFile[]; warnings: string[]; retrieval?: { promptTokens: number; promptBudget: number; rankedFiles: { repository: RepositoryName; path: string }[] } };
export type Plan = {
  summary: string;
  changes: { repository: RepositoryName; path: string; reason: string; steps: string[] }[];
  testScenarios: string[];
  risks: string[];
  questions: string[];
};
export interface AIProvider {
  name: string;
  plan(requirement: Requirement, context: RepositoryContext): Promise<Plan>;
}
export type Run = {
  id: string; status: 'running' | 'completed' | 'failed'; createdAt: string;
  provider: string; requirement: Requirement; context?: RepositoryContext;
  plan?: Plan; error?: string; durationMs?: number;
};
