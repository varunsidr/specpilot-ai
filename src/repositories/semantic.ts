import { checkGpuPlacement, GpuPlacementError, type GpuPlacement } from '../providers/gpu-placement.ts';
export interface Embedder {
  model: string;
  embed(texts: string[], release?: boolean): Promise<number[][]>;
}

export class OllamaEmbedder implements Embedder {
  private url: string;
  private timeoutMs: number;
  private gpuOptions?: { onPlacement: (placement: GpuPlacement) => void };
  model: string;
  constructor(url: string, model: string, timeoutMs: number, gpuOptions?: { onPlacement: (placement: GpuPlacement) => void }) {
    this.url = url;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.gpuOptions = gpuOptions;
  }

  async embed(texts: string[], release = false): Promise<number[][]> {
    if (!texts.length) return [];
    const signal = AbortSignal.timeout(this.timeoutMs);
    let failed = false;
    try {
      if (this.gpuOptions) {
        const load = await fetch(new URL('/api/embed', this.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ model: this.model, input: [], keep_alive: '5m' }) });
        if (!load.ok) throw new GpuPlacementError(`GPU-only evaluation blocked: embedding preload returned HTTP ${load.status}`);
        await load.json();
        this.gpuOptions.onPlacement(await checkGpuPlacement(this.url, this.model, undefined, signal));
      }
      const response = await fetch(new URL('/api/embed', this.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ model: this.model, input: texts, truncate: false, keep_alive: release && !this.gpuOptions ? '0' : '5m' }),
      });
      if (!response.ok) throw new Error(`Ollama embeddings returned HTTP ${response.status}. Check ollama list and OLLAMA_EMBED_MODEL.`);
      const body = await response.json() as { embeddings?: number[][] };
      if (this.gpuOptions) this.gpuOptions.onPlacement(await checkGpuPlacement(this.url, this.model, undefined, signal));
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length ||
          body.embeddings.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) {
        throw new Error('Ollama returned invalid embeddings');
      }
      return body.embeddings;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      // Keep the model loaded until its post-inference placement is checked.
      if (release && this.gpuOptions) {
        try { await this.unload(); }
        catch (error) { if (!failed) throw error; } // Preserve the original hardware/inference failure.
      }
    }
  }

  async unload(): Promise<void> {
    const response = await fetch(new URL('/api/embed', this.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model: this.model, input: [], keep_alive: 0 }) });
    if (!response.ok) throw new Error(`Unloading embedding model returned HTTP ${response.status}`);
    await response.json();
  }
}
