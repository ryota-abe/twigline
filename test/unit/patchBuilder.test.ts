import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRawDiff, type RawFileDiff } from '../../src/git/parsers/diff';
import { buildPatch, type PatchMode } from '../../src/git/PatchBuilder';
import { makeRepo, type TempRepo } from './helpers';

// PatchBuilder: generate random file sets and line selections and apply them in a temporary repository.
// Check that the content of the index (or working tree) matches a model that reflects only the selected changes.

const lineArb = fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', '日本', '');
const fileArb = fc.array(lineArb, { maxLength: 14 }).map((ls) => ls.map((l) => l + '\n').join(''));

function splitKeep(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(from, i + 1));
      from = i + 1;
    }
  }
  if (from < buf.length) out.push(buf.subarray(from));
  return out;
}

/** Forward (stage): the old version with only the selected changes applied */
function modelForward(old: Buffer, diff: RawFileDiff, sel: Set<number>): Buffer {
  const lines = splitKeep(old);
  const out: Buffer[] = [];
  let ptr = 0;
  for (const h of diff.hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    while (ptr < start) out.push(lines[ptr++]);
    for (const l of h.lines) {
      if (l.kind === ' ') out.push(lines[ptr++]);
      else if (l.kind === '-') {
        if (!sel.has(l.id)) out.push(lines[ptr]);
        ptr++;
      } else if (sel.has(l.id)) out.push(Buffer.concat([l.content, l.noEol ? Buffer.alloc(0) : Buffer.from('\n')]));
    }
  }
  while (ptr < lines.length) out.push(lines[ptr++]);
  return Buffer.concat(out);
}

/** Reverse (unstage, discard): the new version with only the selected changes undone */
function modelReverse(cur: Buffer, diff: RawFileDiff, sel: Set<number>): Buffer {
  const lines = splitKeep(cur);
  const out: Buffer[] = [];
  let ptr = 0;
  for (const h of diff.hunks) {
    const start = h.newLines === 0 ? h.newStart : h.newStart - 1;
    while (ptr < start) out.push(lines[ptr++]);
    for (const l of h.lines) {
      if (l.kind === ' ') out.push(lines[ptr++]);
      else if (l.kind === '+') {
        if (!sel.has(l.id)) out.push(lines[ptr]);
        ptr++;
      } else if (sel.has(l.id)) out.push(Buffer.concat([l.content, l.noEol ? Buffer.alloc(0) : Buffer.from('\n')]));
    }
  }
  while (ptr < lines.length) out.push(lines[ptr++]);
  return Buffer.concat(out);
}

function applyArgs(mode: PatchMode): string[] {
  const args = ['apply', '--recount', '--whitespace=nowarn', '--unidiff-zero'];
  if (mode !== 'discard') args.push('--cached');
  if (mode !== 'stage') args.push('--reverse');
  args.push('-');
  return args;
}

function selectIds(diff: RawFileDiff, picks: boolean[]): Set<number> {
  const ids = diff.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== ' ').map((l) => l.id));
  const sel = new Set<number>();
  ids.forEach((id, i) => picks[i % Math.max(picks.length, 1)] && sel.add(id));
  if (sel.size === 0 && ids.length > 0) sel.add(ids[0]);
  return sel;
}

let repo: TempRepo;
beforeAll(() => {
  repo = makeRepo();
  repo.commit('init');
});
afterAll(() => repo.cleanup());

function reset(): void {
  repo.git(['reset', '-q', '--hard']);
  repo.git(['clean', '-qfd']);
}

describe('PatchBuilder property tests with real git', () => {
  const runs = 25;

  it('stage: index equals the model of selected changes', () => {
    fc.assert(
      fc.property(fileArb, fileArb, fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 3 }), (a, b, picks, ctx) => {
        reset();
        repo.write('f.txt', a);
        repo.commit('base', { 'f.txt': a });
        repo.write('f.txt', b);
        const diff = parseRawDiff(repo.gitBuf(['diff', '--no-color', `-U${ctx}`, '--', 'f.txt']));
        if (diff.hunks.length === 0) return;
        const sel = selectIds(diff, picks);
        const patch = buildPatch(diff, sel, 'stage')!;
        repo.git(applyArgs('stage'), { input: patch });
        const actual = repo.gitBuf(['show', ':f.txt']);
        expect(actual.toString('utf8')).toBe(modelForward(Buffer.from(a), diff, sel).toString('utf8'));
      }),
      { numRuns: runs },
    );
  });

  it('unstage: index equals the model with selected changes reverted', () => {
    fc.assert(
      fc.property(fileArb, fileArb, fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 3 }), (a, b, picks, ctx) => {
        reset();
        repo.commit('base', { 'f.txt': a });
        repo.write('f.txt', b);
        repo.git(['add', 'f.txt']);
        const diff = parseRawDiff(repo.gitBuf(['diff', '--cached', '--no-color', `-U${ctx}`, '--', 'f.txt']));
        if (diff.hunks.length === 0) return;
        const sel = selectIds(diff, picks);
        const patch = buildPatch(diff, sel, 'unstage')!;
        repo.git(applyArgs('unstage'), { input: patch });
        const actual = repo.gitBuf(['show', ':f.txt']);
        expect(actual.toString('utf8')).toBe(modelReverse(Buffer.from(b), diff, sel).toString('utf8'));
      }),
      { numRuns: runs },
    );
  });

  it('discard: working tree equals the model with selected changes reverted', () => {
    fc.assert(
      fc.property(fileArb, fileArb, fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), fc.integer({ min: 0, max: 3 }), (a, b, picks, ctx) => {
        reset();
        repo.commit('base', { 'f.txt': a });
        repo.write('f.txt', b);
        const diff = parseRawDiff(repo.gitBuf(['diff', '--no-color', `-U${ctx}`, '--', 'f.txt']));
        if (diff.hunks.length === 0) return;
        const sel = selectIds(diff, picks);
        const patch = buildPatch(diff, sel, 'discard')!;
        repo.git(applyArgs('discard'), { input: patch });
        expect(repo.read('f.txt').toString('utf8')).toBe(modelReverse(Buffer.from(b), diff, sel).toString('utf8'));
      }),
      { numRuns: runs },
    );
  });
});

describe('PatchBuilder special cases', () => {
  it('keeps CRLF and Shift_JIS bytes intact when staging one line', () => {
    reset();
    // "あ" "い" "う" in Shift_JIS
    const sjis = (s: string) => Buffer.from(s, 'latin1');
    const a = Buffer.concat([sjis('\x82\xa0\r\n'), sjis('x\r\n'), sjis('\x82\xa2\r\n')]);
    const b = Buffer.concat([sjis('\x82\xa0\r\n'), sjis('y\r\n'), sjis('\x82\xa4\r\n'), sjis('\x82\xa2\r\n')]);
    repo.commit('sjis', { 's.txt': a });
    repo.write('s.txt', b);
    const diff = parseRawDiff(repo.gitBuf(['diff', '--no-color', '-U3', '--', 's.txt']));
    const added = diff.hunks[0].lines.filter((l) => l.kind === '+');
    const target = added.find((l) => l.content.equals(sjis('\x82\xa4\r')))!;
    const patch = buildPatch(diff, new Set([target.id]), 'stage')!;
    repo.git(applyArgs('stage'), { input: patch });
    expect(repo.gitBuf(['show', ':s.txt']).equals(Buffer.concat([sjis('\x82\xa0\r\n'), sjis('x\r\n'), sjis('\x82\xa4\r\n'), sjis('\x82\xa2\r\n')]))).toBe(true);
  });

  it('handles "No newline at end of file" on the last line', () => {
    reset();
    repo.commit('noeol', { 'n.txt': 'a\nb' });
    repo.write('n.txt', 'a\nb\nc\nd');
    const diff = parseRawDiff(repo.gitBuf(['diff', '--no-color', '-U3', '--', 'n.txt']));
    // Selecting "-b (no newline)" and "+b" adds a newline at the end of the b line
    const ids = diff.hunks[0].lines.filter((l) => l.kind !== ' ' && l.content.toString() === 'b').map((l) => l.id);
    const patch = buildPatch(diff, new Set(ids), 'stage')!;
    repo.git(applyArgs('stage'), { input: patch });
    expect(repo.git(['show', ':n.txt'])).toBe('a\nb\n');
  });

  it('stages part of an untracked file as a new file', () => {
    reset();
    repo.write('new.txt', 'one\ntwo\nthree\n');
    let out: Buffer;
    try {
      out = repo.gitBuf(['diff', '--no-index', '--no-color', '--', '/dev/null', 'new.txt']);
    } catch (e) {
      out = (e as { stdout: Buffer }).stdout;
    }
    const diff = parseRawDiff(out);
    expect(diff.newFile).toBe(true);
    const two = diff.hunks[0].lines.find((l) => l.content.toString() === 'two')!;
    const patch = buildPatch(diff, new Set([two.id]), 'stage')!;
    repo.git(applyArgs('stage'), { input: patch });
    expect(repo.git(['show', ':new.txt'])).toBe('two\n');
  });

  it('unstages part of a newly added file without removing it from the index', () => {
    reset();
    repo.write('added.txt', 'one\ntwo\nthree\n');
    repo.git(['add', 'added.txt']);
    const diff = parseRawDiff(repo.gitBuf(['diff', '--cached', '--no-color', '--', 'added.txt']));
    const two = diff.hunks[0].lines.find((l) => l.content.toString() === 'two')!;
    const patch = buildPatch(diff, new Set([two.id]), 'unstage')!;
    repo.git(applyArgs('unstage'), { input: patch });
    expect(repo.git(['show', ':added.txt'])).toBe('one\nthree\n');
    // Selecting everything removes it from the index
    const diff2 = parseRawDiff(repo.gitBuf(['diff', '--cached', '--no-color', '--', 'added.txt']));
    const all = new Set(diff2.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== ' ').map((l) => l.id)));
    repo.git(applyArgs('unstage'), { input: buildPatch(diff2, all, 'unstage')! });
    expect(repo.git(['ls-files', '--', 'added.txt'])).toBe('');
  });

  it('returns null when nothing is selected', () => {
    reset();
    repo.commit('x', { 'z.txt': 'a\n' });
    repo.write('z.txt', 'b\n');
    const diff = parseRawDiff(repo.gitBuf(['diff', '--no-color', '--', 'z.txt']));
    expect(buildPatch(diff, new Set(), 'stage')).toBeNull();
  });
});
