export type SourceChunk = { startLine: number; endLine: number; startOffset: number; endOffset: number };
const MAX_CHARS = 2400;
const OVERLAP_CHARS = 300;

function lineStarts(raw: string): number[] {
  const starts = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0, high = starts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid] <= offset) low = mid + 1; else high = mid;
  }
  return Math.max(1, low);
}

export function splitIntoChunks(raw: string): SourceChunk[] {
  if (!raw.length) return [];
  const starts = lineStarts(raw);
  const chunks: SourceChunk[] = [];
  let start = 0;
  while (start < raw.length) {
    let end = Math.min(raw.length, start + MAX_CHARS);
    if (end < raw.length) {
      const newline = raw.lastIndexOf('\n', end - 1);
      if (newline > start + MAX_CHARS / 2) end = newline + 1;
    }
    chunks.push({ startLine: lineAt(starts, start), endLine: lineAt(starts, Math.max(start, end - 1)), startOffset: start, endOffset: end });
    if (end === raw.length) break;
    const overlapStart = Math.max(start + 1, end - OVERLAP_CHARS);
    const nextNewline = raw.indexOf('\n', overlapStart);
    start = nextNewline >= 0 && nextNewline + 1 < end ? nextNewline + 1 : overlapStart;
  }
  return chunks;
}

export function expandedLines(raw: string, chunk: SourceChunk, nearby = 6): { startLine: number; endLine: number; content: string } {
  const lines = raw.split(/\r?\n/);
  const startLine = Math.max(1, chunk.startLine - nearby);
  const endLine = Math.min(lines.length, chunk.endLine + nearby);
  return { startLine, endLine, content: lines.slice(startLine - 1, endLine).join('\n') };
}
