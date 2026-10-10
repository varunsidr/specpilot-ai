export type GpuPlacement = { model: string; size: number; sizeVram: number; contextLength?: number; checkedAt: string };
export class GpuPlacementError extends Error {}

const canonical = (name: string) => name.includes(':') ? name : `${name}:latest`;

export function fullGpuPlacement(value: unknown, model: string, numCtx?: number): GpuPlacement {
  const models = (value as { models?: unknown[] } | null)?.models;
  const loaded = Array.isArray(models) ? models.find(item => {
    const candidate = item as { name?: string; model?: string } | null;
    return [candidate?.name, candidate?.model].some(name => typeof name === 'string' && canonical(name) === canonical(model));
  }) as { size?: number; size_vram?: number; context_length?: number } | undefined : undefined;
  if (!loaded) throw new GpuPlacementError(`GPU-only evaluation blocked: ${model} is not reported as loaded by Ollama`);
  // Exact equality is the same rule used by `ollama ps` for "100% GPU".
  if (!Number.isSafeInteger(loaded.size) || loaded.size! <= 0 || loaded.size_vram !== loaded.size) {
    throw new GpuPlacementError(`GPU-only evaluation blocked: ${model} is CPU-offloaded or has unverifiable placement (size=${loaded.size}, size_vram=${loaded.size_vram})`);
  }
  if (numCtx !== undefined && loaded.context_length !== numCtx) throw new GpuPlacementError(`GPU-only evaluation blocked: ${model} context is ${loaded.context_length}, expected ${numCtx}`);
  return { model, size: loaded.size!, sizeVram: loaded.size_vram!, contextLength: loaded.context_length, checkedAt: new Date().toISOString() };
}

export async function checkGpuPlacement(url: string, model: string, numCtx: number | undefined, signal: AbortSignal): Promise<GpuPlacement> {
  try {
    const response = await fetch(new URL('/api/ps', url), { signal });
    if (!response.ok) throw new GpuPlacementError(`GPU-only evaluation blocked: placement check returned HTTP ${response.status}`);
    return fullGpuPlacement(await response.json(), model, numCtx);
  } catch (error) {
    if (error instanceof GpuPlacementError) throw error;
    throw new GpuPlacementError(`GPU-only evaluation blocked: placement could not be verified (${error instanceof Error ? error.message : String(error)})`);
  }
}

export async function prepareGpuModel(url: string, model: string, numCtx: number, signal: AbortSignal): Promise<GpuPlacement> {
  const response = await fetch(new URL('/api/chat', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model, messages: [], stream: false, keep_alive: '5m', options: { num_ctx: numCtx } }) });
  if (!response.ok) throw new GpuPlacementError(`GPU-only evaluation blocked: loading ${model} returned HTTP ${response.status}`);
  await response.json();
  return checkGpuPlacement(url, model, numCtx, signal);
}

export async function unloadModel(url: string, model: string): Promise<void> {
  const response = await fetch(new URL('/api/chat', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ model, messages: [], stream: false, keep_alive: 0 }) });
  if (!response.ok) throw new Error(`Unloading ${model} returned HTTP ${response.status}`);
  await response.json();
}
