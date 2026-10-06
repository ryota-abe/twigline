import { describe, expect, it } from 'vitest';
import type { RefComparison, RefInfo, StatusFile, WorkingTreeStatus } from '../../shared/protocol';
import { integrateStatus, makesMergeCommit, mergeRequirement, mergeStashPaths, rebaseRequirement } from '../../webview/src/util/integrate';

const head = (extra: Partial<RefInfo> = {}): RefInfo => ({ kind: 'head', name: 'topic', fullName: 'refs/heads/topic', sha: 'a'.repeat(40), isHead: true, ...extra });
const cmp = (ahead: number, behind: number, extra: Partial<RefComparison> = {}): RefComparison => ({
  ours: 'a'.repeat(40),
  theirs: 'b'.repeat(40),
  ahead,
  behind,
  mergeBase: 'c'.repeat(40),
  ...extra,
});
const file = (path: string, status: StatusFile['status'] = 'M'): StatusFile => ({ path, status });
const clean: WorkingTreeStatus = { staged: [], unstaged: [], conflicted: [] };
const of = (c: RefComparison | null | undefined, opts: { local?: RefInfo; status?: WorkingTreeStatus } = {}) =>
  integrateStatus({ local: opts.local ?? head(), target: 'main', cmp: c, status: opts.status ?? clean });

describe('integrateStatus', () => {
  it('classifies by the comparison', () => {
    expect(of(undefined).state).toBe('loading');
    expect(of(null).state).toBe('unknown');
    expect(of(cmp(3, 0)).state).toBe('upToDate');
    expect(of(cmp(0, 2))).toMatchObject({ state: 'fastForward', behind: 2 });
    expect(of(cmp(1, 2))).toMatchObject({ state: 'diverged', ahead: 1, behind: 2 });
    expect(of(cmp(1, 2, { mergeBase: null })).state).toBe('unrelated');
  });

  it('tells when a rebase rewrites pushed commits', () => {
    // topic is pushed to origin/topic with 1 unpushed commit; 3 commits are not on main
    const pushed = head({ upstream: 'origin/topic', ahead: 1 });
    expect(of(cmp(3, 2), { local: pushed }).rewritesPushed).toBe(true);
    expect(of(cmp(3, 2, { mergeBase: null }), { local: pushed }).rewritesPushed).toBe(true);
    expect(of(cmp(1, 2), { local: pushed }).rewritesPushed).toBe(false);
    // Not pushed anywhere, or the upstream is gone
    expect(of(cmp(3, 2)).rewritesPushed).toBe(false);
    expect(of(cmp(3, 2), { local: head({ upstream: 'origin/topic', gone: true }) }).rewritesPushed).toBe(false);
  });
});

describe('mergeRequirement / rebaseRequirement', () => {
  const dirty: WorkingTreeStatus = { ...clean, unstaged: [file('b.txt')] };

  it('refuses unrelated histories for a merge only', () => {
    expect(mergeRequirement(of(cmp(1, 1, { mergeBase: null })), 'auto')).toBe('unrelated');
    expect(rebaseRequirement(of(cmp(1, 1, { mergeBase: null })))).toBeNull();
  });

  it('needs a stash for overlapping changes with a merge, and for any change with a rebase', () => {
    expect(mergeRequirement(of(cmp(0, 1, { incomingFiles: ['x.txt'] }), { status: dirty }), 'auto')).toBeNull();
    expect(mergeRequirement(of(cmp(1, 1, { incomingFiles: ['b.txt'] }), { status: dirty }), 'auto')).toBe('stash');
    expect(rebaseRequirement(of(cmp(1, 1, { incomingFiles: ['x.txt'] }), { status: dirty }))).toBe('stash');
    // Nothing to rebase: nothing to ask
    expect(rebaseRequirement(of(cmp(2, 0), { status: dirty }))).toBeNull();
    expect(rebaseRequirement(of(cmp(1, 1), { status: { ...clean, unstaged: [file('u.txt', '?')] } }))).toBeNull();
  });

  it('needs a stash for any staged change when the merge creates a merge commit', () => {
    // c.txt is staged; the incoming commits change only x.txt (git merge requires the index to match HEAD for a merge commit)
    const staged: WorkingTreeStatus = { ...clean, staged: [file('c.txt')] };
    const ff = of(cmp(0, 1, { incomingFiles: ['x.txt'] }), { status: staged });
    const diverged = of(cmp(1, 1, { incomingFiles: ['x.txt'] }), { status: staged });
    expect(ff.staged).toEqual(['c.txt']);
    // A fast-forward (also with --squash) checks out like a switch and keeps the staged change
    expect(mergeRequirement(ff, 'auto')).toBeNull();
    expect(mergeRequirement(ff, 'squash')).toBeNull();
    expect(mergeRequirement(ff, 'noFf')).toBe('stash');
    expect(mergeRequirement(diverged, 'auto')).toBe('stash');
    expect(mergeRequirement(diverged, 'squash')).toBe('stash');
    expect(mergeStashPaths(diverged, makesMergeCommit(diverged, 'auto'))).toEqual({ overlap: [], staged: ['c.txt'] });
    expect(mergeStashPaths(ff, makesMergeCommit(ff, 'auto'))).toEqual({ overlap: [], staged: [] });
    // A path already listed as overlapping is not listed twice
    const both = of(cmp(1, 1, { incomingFiles: ['c.txt'] }), { status: staged });
    expect(mergeStashPaths(both, true)).toEqual({ overlap: ['c.txt'], staged: [] });
    // Unstaged changes in other files do not stop a merge commit
    expect(mergeRequirement(of(cmp(1, 1, { incomingFiles: ['x.txt'] }), { status: { ...clean, unstaged: [file('c.txt')] } }), 'noFf')).toBeNull();
  });
});
