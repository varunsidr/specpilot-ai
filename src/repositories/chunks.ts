import ts from 'typescript';
import { parseSource } from './profile.ts';
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

function textChunks(raw: string): SourceChunk[] {
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

// Keep complete syntax nodes together when they fit. Oversized components descend
// into statements and JSX children; oversized leaves retain the text fallback.
export function splitIntoChunks(raw: string, filename?: string, parsed?: ts.SourceFile): SourceChunk[] {
  const source = parsed ?? (filename ? parseSource(raw, filename) : undefined);
  if (!source || raw.length <= MAX_CHARS) return textChunks(raw);
  const starts = lineStarts(raw);
  const atoms: { startOffset: number; endOffset: number }[] = [];
  const divide = (node: ts.Node, start: number, end: number): void => {
    if (end <= start) return;
    if (end - start <= MAX_CHARS) { atoms.push({ startOffset: start, endOffset: end }); return; }
    const children: ts.Node[] = [];
    ts.forEachChild(node, child => { if (child.end > child.pos) children.push(child); });
    if (!children.length) {
      atoms.push(...textChunks(raw.slice(start, end)).map(chunk => ({ startOffset: start + chunk.startOffset, endOffset: start + chunk.endOffset })));
      return;
    }
    let cursor = start;
    for (const child of children) {
      const childStart = Math.max(cursor, child.getFullStart());
      if (childStart > cursor) atoms.push(...textChunks(raw.slice(cursor, childStart)).map(chunk => ({ startOffset: cursor + chunk.startOffset, endOffset: cursor + chunk.endOffset })));
      divide(child, childStart, child.end);
      cursor = child.end;
    }
    if (cursor < end) atoms.push(...textChunks(raw.slice(cursor, end)).map(chunk => ({ startOffset: cursor + chunk.startOffset, endOffset: cursor + chunk.endOffset })));
  };
  divide(source, 0, raw.length);
  const packed: typeof atoms = [];
  for (const atom of atoms) {
    const previous = packed.at(-1);
    if (previous && previous.endOffset === atom.startOffset && atom.endOffset - previous.startOffset <= MAX_CHARS) previous.endOffset = atom.endOffset;
    else packed.push({ ...atom });
  }
  return packed.map(chunk => ({ ...chunk, startLine: lineAt(starts, chunk.startOffset), endLine: lineAt(starts, chunk.endOffset - 1) }));
}

export function expandedLines(raw: string, chunk: SourceChunk, nearby = 6): { startLine: number; endLine: number; content: string } {
  const lines = raw.split(/\r?\n/);
  const startLine = Math.max(1, chunk.startLine - nearby);
  const endLine = Math.min(lines.length, chunk.endLine + nearby);
  return { startLine, endLine, content: lines.slice(startLine - 1, endLine).join('\n') };
}
