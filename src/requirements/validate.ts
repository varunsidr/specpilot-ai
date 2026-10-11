import type { PinnedFile, Requirement, QuantityContract } from '../types.ts';
export class InputError extends Error {}
export function validateRequirement(value: unknown): Requirement {
  if (!value || typeof value !== 'object') throw new InputError('Expected a JSON object');
  const r = value as Record<string, unknown>;
  const validText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!validText(r.title, 200)) throw new InputError('title must be 1–200 characters');
  if (!validText(r.description, 4000)) throw new InputError('description must be 1–4000 characters');
  if (!Array.isArray(r.acceptanceCriteria) || r.acceptanceCriteria.length < 1 || r.acceptanceCriteria.length > 20 || !r.acceptanceCriteria.every(v => validText(v, 500))) {
    throw new InputError('acceptanceCriteria must contain 1–20 nonempty strings, each up to 500 characters');
  }
  let pinnedFiles: PinnedFile[] | undefined;
  if (r.pinnedFiles !== undefined) {
    if (!Array.isArray(r.pinnedFiles) || r.pinnedFiles.length > 8) throw new InputError('pinnedFiles must be an array with at most 8 files');
    pinnedFiles = r.pinnedFiles.map((value): PinnedFile => {
      if (!value || typeof value !== 'object') throw new InputError('Each pinned file needs repository and path');
      const pin = value as Record<string, unknown>;
      if ((pin.repository !== 'website' && pin.repository !== 'tests') || typeof pin.path !== 'string' ||
          !pin.path || pin.path.length > 300 || pin.path.includes('\\') || pin.path.startsWith('/') ||
          pin.path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(pin.path)) {
        throw new InputError('Pinned files need a website/tests repository and a safe forward-slash relative path');
      }
      return { repository: pin.repository, path: pin.path };
    });
    if (new Set(pinnedFiles.map(pin => `${pin.repository}:${pin.path}`)).size !== pinnedFiles.length) throw new InputError('pinnedFiles contains duplicates');
  }
  let scenarioContracts: QuantityContract[] | undefined;
  if (r.scenarioContracts !== undefined) {
    if (!Array.isArray(r.scenarioContracts) || r.scenarioContracts.length > r.acceptanceCriteria.length) throw new InputError('scenarioContracts must contain at most one contract per criterion');
    const seen = new Set<number>();
    scenarioContracts = r.scenarioContracts.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid scenario contract');
      const c = value as Record<string, unknown>;
      const keys = ['kind', 'criterion', 'direction', 'step', 'minimum'];
      if (Object.keys(c).length !== keys.length || keys.some(key => !(key in c)) || c.kind !== 'quantity_step' ||
          !Number.isInteger(c.criterion) || (c.criterion as number) < 1 || (c.criterion as number) > (r.acceptanceCriteria as string[]).length || seen.has(c.criterion as number) ||
          !['increase', 'decrease'].includes(c.direction as string) || !Number.isSafeInteger(c.step) || (c.step as number) < 1 ||
          !Number.isSafeInteger(c.minimum) || (c.minimum as number) < 1 || (c.minimum as number) + 3 * (c.step as number) > 1000000) {
        throw new InputError('Quantity contracts need unique valid criteria, increase/decrease direction, positive integer step/minimum, and minimum + 3*step <= 1000000');
      }
      seen.add(c.criterion as number);
      return { kind: 'quantity_step', criterion: c.criterion as number, direction: c.direction as QuantityContract['direction'], step: c.step as number, minimum: c.minimum as number };
    });
  }
  return { title: r.title.trim(), description: r.description.trim(), acceptanceCriteria: r.acceptanceCriteria.map(v => v.trim()), ...(pinnedFiles ? { pinnedFiles } : {}), ...(scenarioContracts ? { scenarioContracts } : {}) };
}
