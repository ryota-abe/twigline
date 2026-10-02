import type { RawFileDiff, RawHunk, RawLineKind } from './parsers/diff';

// ---------------------------------------------------------------------------
// PatchBuilder
// ---------------------------------------------------------------------------

export type PatchMode = 'stage' | 'unstage' | 'discard';

/**
 * Builds a patch that reflects only the selected lines.
 *   stage   : apply the index -> working tree diff forward with git apply --cached
 *   unstage : apply the HEAD -> index diff with git apply --cached --reverse
 *   discard : apply the index -> working tree diff to the working tree with git apply --reverse
 * Forward: unselected + is dropped and - becomes context. Reverse: unselected + becomes context and - is dropped.
 * Returns null if the patch would change nothing.
 */
export function buildPatch(diff: RawFileDiff, selectedIds: ReadonlySet<number>, mode: PatchMode): Buffer | null {
  const forward = mode === 'stage';
  const out: Buffer[] = [];
  const NL = Buffer.from('\n');
  const NO_EOL = Buffer.from('\\ No newline at end of file\n');

  interface OutLine {
    kind: RawLineKind;
    content: Buffer;
    noEol: boolean;
  }
  const hunks: { oldStart: number; newStart: number; oldLines: number; newLines: number; origOldStart: number; origNewStart: number; origOldLines: number; origNewLines: number; lines: OutLine[] }[] = [];
  let changedTotal = 0;
  let allChangesSelected = true;

  for (const h of diff.hunks) {
    const lines: OutLine[] = [];
    let changed = 0;
    for (const l of h.lines) {
      if (l.kind === ' ') {
        lines.push({ kind: ' ', content: l.content, noEol: l.noEol });
        continue;
      }
      const selected = selectedIds.has(l.id);
      if (!selected) allChangesSelected = false;
      if (selected) {
        lines.push({ kind: l.kind, content: l.content, noEol: l.noEol });
        changed++;
      } else if ((l.kind === '+' && !forward) || (l.kind === '-' && forward)) {
        lines.push({ kind: ' ', content: l.content, noEol: l.noEol });
      }
      // Everything else (unselected + when forward, unselected - when reverse) is dropped
    }
    if (changed === 0) continue;
    changedTotal += changed;
    let oldLines = 0;
    let newLines = 0;
    for (const l of lines) {
      if (l.kind !== '+') oldLines++;
      if (l.kind !== '-') newLines++;
    }
    hunks.push({
      oldStart: h.oldStart,
      newStart: h.newStart,
      oldLines,
      newLines,
      origOldStart: h.oldStart,
      origNewStart: h.newStart,
      origOldLines: h.oldLines,
      origNewLines: h.newLines,
      lines,
    });
  }
  if (changedTotal === 0) return null;

  // Recompute start lines. Going forward the old-side position is unchanged from the original diff; in reverse, the new-side one.
  let delta = 0; // (new-side lines - old-side lines) of the hunks so far
  for (const h of hunks) {
    if (forward) {
      const oldPos = h.origOldLines === 0 ? h.origOldStart : h.origOldStart - 1;
      const newPos = oldPos + delta;
      h.oldStart = h.origOldStart;
      h.newStart = h.newLines === 0 ? newPos : newPos + 1;
    } else {
      const newPos = h.origNewLines === 0 ? h.origNewStart : h.origNewStart - 1;
      const oldPos = newPos - delta;
      h.newStart = h.origNewStart;
      h.oldStart = h.oldLines === 0 ? oldPos : oldPos + 1;
    }
    delta += h.newLines - h.oldLines;
  }

  // File header. When only part of a new file is applied in reverse, use a "modify" patch
  // (the reverse of creating a file is deleting it, which cannot leave part of it behind).
  const convertNewFileToModify = diff.newFile && !forward && !allChangesSelected;
  for (const hl of diff.headerLines) {
    const text = hl.toString('latin1');
    if (convertNewFileToModify) {
      if (text.startsWith('new file mode ') || text.startsWith('index ')) continue;
      if (text.startsWith('--- ')) {
        const plus = diff.headerLines.find((l) => l.toString('latin1').startsWith('+++ '));
        const target = plus ? plus.subarray(4).toString('latin1').replace(/^b\//, 'a/') : 'a/file';
        out.push(Buffer.from('--- ', 'latin1'), Buffer.from(target, 'latin1'), NL);
        continue;
      }
    }
    out.push(hl, NL);
  }

  for (const h of hunks) {
    out.push(Buffer.from(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n`, 'latin1'));
    for (const l of h.lines) {
      out.push(Buffer.from(l.kind, 'latin1'), l.content, NL);
      if (l.noEol) out.push(NO_EOL);
    }
  }
  return Buffer.concat(out);
}

/** List of line IDs that select a whole hunk */
export function hunkLineIds(hunk: RawHunk): number[] {
  return hunk.lines.filter((l) => l.kind !== ' ').map((l) => l.id);
}
