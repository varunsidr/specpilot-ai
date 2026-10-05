export interface Embedder {
  model: string;
  embed(texts: string[], release?: boolean): Promise<number[][]>;
}

export class OllamaEmbedder implements Embedder {
  private url: string;
  private timeoutMs: number;
  model: string;
  constructor(url: string, model: string, timeoutMs: number) {
    this.url = url;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async embed(texts: string[], release = false): Promise<number[][]> {
    if (!texts.length) return [];
    const response = await fetch(new URL('/api/embed', this.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ model: this.model, input: texts, truncate: false, keep_alive: release ? '0' : '5m' }),
    });
    if (!response.ok) throw new Error(`Ollama embeddings returned HTTP ${response.status}. Check ollama list and OLLAMA_EMBED_MODEL.`);
    const body = await response.json() as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length ||
        body.embeddings.some(vector => !Array.isArray(vector) || !vector.length || vector.some(value => !Number.isFinite(value)))) {
      throw new Error('Ollama returned invalid embeddings');
    }
    return body.embeddings;
  }
}
