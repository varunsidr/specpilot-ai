export type RepositoryName = 'website' | 'tests';
export type PinnedFile = { repository: RepositoryName; path: string };
export type Requirement = { title: string; description: string; acceptanceCriteria: string[]; pinnedFiles?: PinnedFile[] };
export type ContextFile = { repository: RepositoryName; path: string; content: string; truncated: boolean; startLine?: number; endLine?: number; reason?: 'pinned' | 'semantic' | 'import' | 'test' | 'requested' | 'evidence' };
export type ContextRequest = PinnedFile & { startLine: number; endLine: number; reason: string };
export type Evidence = PinnedFile & { startLine: number; endLine: number; quote: string };
export type CriterionAssessment = { criterion: number; status: 'implemented' | 'gap' | 'unknown'; observation: string; evidence: Evidence[] };
export type CriterionRetrieval = {
  // Initial retrieval candidates and nominations; these are not assessment evidence.
  criterion: number;
  rankedFiles: PinnedFile[];
  selectedRanges: (PinnedFile & { startLine: number; endLine: number })[];
};
export type SourceLink = {
  name: string; kind: 'call' | 'event' | 'render';
  caller: PinnedFile & { startLine: number; endLine: number };
  definition: PinnedFile & { startLine: number; endLine: number };
};
export type RepositoryContext = {
  files: ContextFile[]; warnings: string[]; availableFiles?: PinnedFile[];
  followUps?: { requests: ContextRequest[]; served: ContextRequest[]; warnings: string[] }[];
  retrieval?: { promptTokens: number; promptBudget: number; rankedFiles: PinnedFile[]; strategy?: 'requirement' | 'criterion'; criteria?: CriterionRetrieval[];
    selectionVersion?: number; anchors?: (PinnedFile & { startLine: number; endLine: number })[]; sourceLinks?: SourceLink[] };
};
export type Plan = {
  schemaVersion: 2;
  outcome: 'already_implemented' | 'changes_needed' | 'needs_context';
  summary: string;
  assessments: CriterionAssessment[];
  changes: { repository: RepositoryName; path: string; criterion: number; gap: string; evidence: Evidence[]; reason: string; steps: string[] }[];
  contextRequests: ContextRequest[];
  testScenarios: string[];
  risks: string[];
  questions: string[];
};
export interface AIProvider {
  name: string;
  lastMetrics?: unknown;
  plan(requirement: Requirement, context: RepositoryContext, options?: { resolveContext?: (requests: ContextRequest[], retainEvidence: Evidence[]) => Promise<RepositoryContext> }): Promise<Plan>;
}
export type Run = {
  id: string; status: 'running' | 'completed' | 'failed'; createdAt: string;
  provider: string; requirement: Requirement; context?: RepositoryContext;
  plan?: Plan; error?: string; durationMs?: number;
  planningMetrics?: unknown;
};
