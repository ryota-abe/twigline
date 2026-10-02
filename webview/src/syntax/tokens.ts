import type { DiffLine, FileDiff } from '../../../shared/protocol';

// The part used for coloring diffs that depends on neither the DOM nor Shiki (covered by unit tests).

/** One token. Draws len characters in color (the default text color if absent). style is the bits of Shiki's FontStyle */
export interface Tok {
  len: number;
  color?: string;
  style?: number;
}

export const FONT_ITALIC = 1;
export const FONT_BOLD = 2;
export const FONT_UNDERLINE = 4;
export const FONT_STRIKETHROUGH = 8;

/**
 * Split a diff, per hunk, into consecutive "before" and "after" text.
 * Before is the context and deleted lines; after is the context and added lines. Context lines use the "after" result.
 * Some grammars change state (inside a string or comment) mid-line, so color in chunks, not line by line.
 */
export function diffBlocks(diff: FileDiff): { blocks: string[][]; where: Map<number, [block: number, index: number]> } {
  const blocks: string[][] = [];
  const where = new Map<number, [number, number]>();
  for (const h of diff.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const oldBlock = blocks.length;
    const newBlock = oldBlock + 1;
    for (const l of h.lines) {
      if (l.kind === '-') {
        where.set(l.id, [oldBlock, oldLines.length]);
        oldLines.push(l.text);
      } else if (l.kind === '+') {
        where.set(l.id, [newBlock, newLines.length]);
        newLines.push(l.text);
      } else {
        oldLines.push(l.text);
        where.set(l.id, [newBlock, newLines.length]);
        newLines.push(l.text);
      }
    }
    blocks.push(oldLines, newLines);
  }
  return { blocks, where };
}

/** Make the Worker's result (tokens per chunk and per line) available by line ID */
export function tokensByLine(diff: FileDiff, where: Map<number, [number, number]>, result: Tok[][][]): Map<number, Tok[]> {
  const out = new Map<number, Tok[]>();
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      const w = where.get(l.id);
      const toks = w ? result[w[0]]?.[w[1]] : undefined;
      if (toks && tokensMatch(l, toks)) out.set(l.id, toks);
    }
  }
  return out;
}

function tokensMatch(line: DiffLine, toks: Tok[]): boolean {
  let n = 0;
  for (const t of toks) n += t.len;
  return n === line.text.length;
}

/** A piece to draw. changed is the range highlighted by the word-level diff */
export interface Piece {
  text: string;
  color?: string;
  style?: number;
}
export interface Group {
  changed: boolean;
  pieces: Piece[];
}

/**
 * Overlay syntax colors (tokens) and word-level highlights (words).
 * Group by highlight range (so there is a single <mark>), then split inside it at token boundaries.
 */
export function mergeHighlights(text: string, toks: Tok[] | undefined, words: { text: string; changed: boolean }[] | undefined): Group[] {
  const ranges = words ?? [{ text, changed: false }];
  const groups: Group[] = [];
  let ti = 0;
  let tokStart = 0;
  let pos = 0;
  for (const r of ranges) {
    const end = pos + r.text.length;
    const pieces: Piece[] = [];
    if (!toks) {
      pieces.push({ text: r.text });
    } else {
      let p = pos;
      while (p < end) {
        while (ti < toks.length && tokStart + toks[ti].len <= p) {
          tokStart += toks[ti].len;
          ti++;
        }
        const tok = toks[ti];
        const stop = tok ? Math.min(end, tokStart + tok.len) : end;
        pieces.push({ text: text.slice(p, stop), color: tok?.color, style: tok?.style || undefined });
        p = stop;
      }
    }
    if (pieces.length > 0) groups.push({ changed: r.changed, pieces });
    pos = end;
  }
  return groups;
}
