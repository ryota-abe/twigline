import { describe, expect, it } from 'vitest';
import type { RefComparison, RefInfo, StatusFile, WorkingTreeStatus } from '../../shared/protocol';
import { resetStatus, type ResetMode } from '../../webview/src/util/resetStatus';

const head = (extra: Partial<RefInfo> = {}): RefInfo => ({ kind: 'head', name: 'main', fullName: 'refs/heads/main', sha: 'a'.repeat(40), isHead: true, ...extra });
const cmp = (ahead: number, behind: number): RefComparison => ({ ours: 'a'.repeat(40), theirs: 'b'.repeat(40), ahead, behind, mergeBase: 'c'.repeat(40) });
const file = (path: string, status: StatusFile['status'] = 'M'): StatusFile => ({ path, status });
const clean: WorkingTreeStatus = { staged: [], unstaged: [], conflicted: [] };
const of = (
  c: RefComparison | null | undefined,
  opts: { mode?: ResetMode; local?: RefInfo; toUpstream?: RefComparison; orphaned?: number; status?: WorkingTreeStatus } = {},
) => resetStatus({ local: opts.local ?? head(), cmp: c, toUpstream: opts.toUpstream, orphaned: opts.orphaned, mode: opts.mode ?? 'mixed', status: opts.status ?? clean });

describe('resetStatus', () => {
  it('classifies by how the target relates to HEAD', () => {
    expect(of(undefined).state).toBe('loading');
    expect(of(null).state).toBe('unknown');
    expect(of(cmp(3, 0))).toMatchObject({ state: 'back', removed: 3, added: 0 });
    expect(of(cmp(0, 2))).toMatchObject({ state: 'forward', removed: 0, added: 2 });
    expect(of(cmp(1, 2))).toMatchObject({ state: 'sideways', removed: 1, added: 2 });
    expect(of(cmp(0, 0)).state).toBe('same');
  });

  it('knows when a reset to the same commit changes nothing', () => {
    const staged: WorkingTreeStatus = { ...clean, staged: [file('a.txt')] };
    const unstaged: WorkingTreeStatus = { ...clean, unstaged: [file('b.txt'), file('new.txt', '?')] };
    expect(of(cmp(0, 0), { mode: 'soft', status: staged }).nothing).toBe(true);
    expect(of(cmp(0, 0), { mode: 'mixed', status: unstaged }).nothing).toBe(true);
    expect(of(cmp(0, 0), { mode: 'mixed', status: staged }).nothing).toBe(false);
    // Untracked files are kept by a hard reset
    expect(of(cmp(0, 0), { mode: 'hard', status: unstaged })).toMatchObject({ nothing: false, discarded: 1 });
    expect(of(cmp(0, 0), { mode: 'hard' }).nothing).toBe(true);
    expect(of(cmp(1, 0), { mode: 'soft' }).nothing).toBe(false);
  });

  it('counts the pushed commits taken off', () => {
    // 3 commits taken off, 1 of them unpushed: the upstream has 2 commits beyond the target
    const local = head({ upstream: 'origin/main', ahead: 1, behind: 0 });
    expect(of(cmp(3, 0), { local, toUpstream: { ...cmp(0, 2) } }).pushedRemoved).toBe(2);
    // Only unpushed commits taken off: the upstream has nothing beyond the target
    expect(of(cmp(1, 0), { local, toUpstream: cmp(0, 0) }).pushedRemoved).toBe(0);
    // Commits only the upstream has (never on this branch) are not counted
    expect(of(cmp(1, 0), { local: head({ upstream: 'origin/main', ahead: 1, behind: 4 }), toUpstream: cmp(0, 4) }).pushedRemoved).toBe(0);
    // No upstream (or a deleted one): nothing is pushed
    expect(of(cmp(3, 0), { toUpstream: cmp(0, 2) }).pushedRemoved).toBe(0);
    expect(of(cmp(3, 0), { local: head({ upstream: 'origin/main', gone: true }), toUpstream: cmp(0, 2) }).pushedRemoved).toBe(0);
  });

  it('passes the orphaned count through', () => {
    expect(of(cmp(2, 0), { orphaned: 1 }).orphaned).toBe(1);
    expect(of(cmp(2, 0)).orphaned).toBeUndefined();
  });
});
