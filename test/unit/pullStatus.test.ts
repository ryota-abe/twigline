import { describe, expect, it } from 'vitest';
import type { RefComparison, RefInfo, StatusFile, WorkingTreeStatus } from '../../shared/protocol';
import { pullRequirement, pullStatus } from '../../webview/src/util/pullStatus';

const head = (extra: Partial<RefInfo> = {}): RefInfo => ({ kind: 'head', name: 'main', fullName: 'refs/heads/main', sha: 'a'.repeat(40), isHead: true, ...extra });
const remoteRef: RefInfo = { kind: 'remote', name: 'origin/main', fullName: 'refs/remotes/origin/main', sha: 'b'.repeat(40), remote: 'origin' };
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

const of = (c: RefComparison | null | undefined, opts: { local?: RefInfo; status?: WorkingTreeStatus | null; remote?: RefInfo | undefined } = {}) =>
  pullStatus({ local: opts.local ?? head(), target: 'origin/main', remoteRef: 'remote' in opts ? opts.remote : remoteRef, cmp: c, status: opts.status === undefined ? clean : opts.status });

describe('pullStatus', () => {
  it('classifies by the comparison with the remote-tracking branch', () => {
    expect(of(cmp(0, 0)).state).toBe('upToDate');
    expect(of(cmp(2, 0)).state).toBe('upToDate');
    expect(of(cmp(0, 3))).toMatchObject({ state: 'fastForward', behind: 3, ffImpossible: false });
    expect(of(cmp(1, 3))).toMatchObject({ state: 'diverged', ahead: 1, behind: 3, ffImpossible: true });
    expect(of(cmp(1, 3, { mergeBase: null }))).toMatchObject({ state: 'unrelated', ffImpossible: true });
    expect(of(undefined).state).toBe('loading');
    expect(of(null).state).toBe('unknown');
    expect(of(undefined, { remote: undefined }).state).toBe('notFetched');
  });

  it('finds local changes the incoming commits also change', () => {
    const status: WorkingTreeStatus = { staged: [file('a.txt', 'A')], unstaged: [file('b.txt'), file('c.txt'), file('new.txt', '?')], conflicted: [] };
    const s = of(cmp(0, 2, { incomingFiles: ['a.txt', 'c.txt', 'new.txt', 'z.txt'] }), { status });
    expect(s.dirty).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(s.overlap).toEqual(['a.txt', 'c.txt']);
    expect(s.untrackedOverlap).toEqual(['new.txt']);
    // A branch that is not checked out does not look at the working tree
    expect(of(cmp(0, 2, { incomingFiles: ['a.txt'] }), { status: null })).toMatchObject({ dirty: [], overlap: [] });
  });

  it('notices a rebase that rewrites commits already on another upstream', () => {
    // feature is pushed to origin/feature with 1 unpushed commit, and 3 commits are not on origin/main
    const feature = head({ name: 'feature', upstream: 'origin/feature', ahead: 1 });
    expect(of(cmp(3, 2), { local: feature }).rewritesPushed).toBe(true);
    expect(of(cmp(1, 2), { local: feature }).rewritesPushed).toBe(false);
    // Pulling its own upstream: the local-only commits are the unpushed ones
    expect(of(cmp(3, 2), { local: head({ upstream: 'origin/main', ahead: 3 }) }).rewritesPushed).toBe(false);
  });
});

describe('pullRequirement', () => {
  it('needs merge or rebase when fast-forward is impossible', () => {
    expect(pullRequirement(of(cmp(1, 1)), 'ffOnly')).toBe('ff');
    expect(pullRequirement(of(cmp(1, 1)), 'merge')).toBeNull();
    expect(pullRequirement(of(cmp(0, 1)), 'ffOnly')).toBeNull();
    expect(pullRequirement(of(cmp(1, 1, { mergeBase: null })), 'merge')).toBe('unrelated');
  });

  it('needs a stash for any change with rebase, and for overlapping changes with merge', () => {
    const status: WorkingTreeStatus = { ...clean, unstaged: [file('b.txt')] };
    expect(pullRequirement(of(cmp(0, 1, { incomingFiles: ['x.txt'] }), { status }), 'rebase')).toBe('stash');
    expect(pullRequirement(of(cmp(0, 1, { incomingFiles: ['x.txt'] }), { status }), 'merge')).toBeNull();
    expect(pullRequirement(of(cmp(0, 1, { incomingFiles: ['b.txt'] }), { status }), 'merge')).toBe('stash');
    expect(pullRequirement(of(cmp(0, 1, { incomingFiles: ['b.txt'] }), { status }), 'ffOnly')).toBe('stash');
    // Untracked files alone do not stop a rebase
    expect(pullRequirement(of(cmp(0, 1), { status: { ...clean, unstaged: [file('u.txt', '?')] } }), 'rebase')).toBeNull();
  });
});
