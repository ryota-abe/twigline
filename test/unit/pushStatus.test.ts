import { describe, expect, it } from 'vitest';
import type { PullRequestInfo, PullRequestList, RefComparison, RefInfo } from '../../shared/protocol';
import { pullRequestFor, pushComparePair, pushRowDefaults, pushStatus } from '../../webview/src/util/pushStatus';

const head = (name: string, extra: Partial<RefInfo> = {}): RefInfo => ({ kind: 'head', name, fullName: `refs/heads/${name}`, sha: 'a'.repeat(40), ...extra });
const remoteRef = (name: string, sha = 'b'.repeat(40)): RefInfo => ({ kind: 'remote', name, fullName: `refs/remotes/${name}`, sha, remote: name.split('/')[0] });

describe('pushStatus', () => {
  it('classifies by ahead / behind against the upstream', () => {
    const refs = [remoteRef('origin/main')];
    const of = (extra: Partial<RefInfo>) => pushStatus(head('main', { upstream: 'origin/main', ...extra }), refs, 'origin', 'main');
    expect(of({ ahead: 3, behind: 0 })).toMatchObject({ state: 'ahead', ahead: 3, forceRequired: false });
    expect(of({ ahead: 0, behind: 0 })).toMatchObject({ state: 'upToDate', forceRequired: false });
    expect(of({ ahead: 0, behind: 2 })).toMatchObject({ state: 'behind', behind: 2, forceRequired: true });
    expect(of({ ahead: 1, behind: 2 })).toMatchObject({ state: 'diverged', ahead: 1, behind: 2, forceRequired: true });
    expect(of({ gone: true })).toMatchObject({ state: 'gone', forceRequired: false });
  });

  it('treats a branch with no remote branch as new', () => {
    expect(pushStatus(head('topic'), [remoteRef('origin/main')], 'origin', 'topic')).toMatchObject({ state: 'new', forceRequired: false });
  });

  it('does not guess for a remote branch that is not the upstream', () => {
    const refs = [remoteRef('origin/topic'), remoteRef('origin/main')];
    expect(pushStatus(head('topic', { upstream: 'origin/main' }), refs, 'origin', 'topic')).toMatchObject({ state: 'unknown', forceRequired: false });
    expect(pushStatus(head('topic', { upstream: 'origin/main' }), [remoteRef('origin/topic', 'a'.repeat(40))], 'origin', 'topic')).toMatchObject({ state: 'upToDate' });
  });
});

describe('pushStatus with a comparison on the host', () => {
  const local = head('topic', { upstream: 'origin/main' });
  const refs = [remoteRef('origin/topic'), remoteRef('origin/main')];
  const cmp = (ahead: number, behind: number, theirs = 'b'.repeat(40)): RefComparison => ({ ours: 'a'.repeat(40), theirs, ahead, behind, mergeBase: 'c'.repeat(40) });

  it('asks for a comparison only when the remote branch is not the upstream and differs', () => {
    expect(pushComparePair(local, refs, 'origin', 'topic')).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(pushComparePair(local, refs, 'origin', 'main')).toBeUndefined();
    expect(pushComparePair(local, refs, 'origin', 'other')).toBeUndefined();
    expect(pushComparePair(local, [remoteRef('origin/topic', 'a'.repeat(40))], 'origin', 'topic')).toBeUndefined();
  });

  it('classifies an unknown remote branch by the comparison', () => {
    expect(pushStatus(local, refs, 'origin', 'topic', cmp(2, 0))).toMatchObject({ state: 'ahead', ahead: 2, forceRequired: false });
    expect(pushStatus(local, refs, 'origin', 'topic', cmp(1, 3))).toMatchObject({ state: 'diverged', ahead: 1, behind: 3, forceRequired: true });
    expect(pushStatus(local, refs, 'origin', 'topic', null).state).toBe('unknown');
    // A comparison of other commits (made before a ref moved) is ignored
    expect(pushStatus(local, refs, 'origin', 'topic', cmp(1, 3, 'd'.repeat(40))).state).toBe('unknown');
  });
});

describe('pushRowDefaults', () => {
  it('derives the row from the chosen remote', () => {
    const main = head('main', { upstream: 'origin/main', ahead: 2, behind: 0 });
    expect(pushRowDefaults(main, 'origin')).toEqual({ remote: 'main', checked: true, track: false });
    // Another remote: same name, not selected (nothing is known to be unpushed there)
    expect(pushRowDefaults(main, 'fork')).toEqual({ remote: 'main', checked: false, track: false });
    // An upstream with another name on that remote
    expect(pushRowDefaults(head('x', { upstream: 'origin/feature/x', ahead: 1 }), 'origin').remote).toBe('feature/x');
    // Not selected when a force push would be needed, or when the upstream is gone
    expect(pushRowDefaults(head('d', { upstream: 'origin/d', ahead: 1, behind: 1 }), 'origin').checked).toBe(false);
    expect(pushRowDefaults(head('g', { upstream: 'origin/g', gone: true }), 'origin').checked).toBe(false);
    // No upstream yet: tracked by default
    expect(pushRowDefaults(head('new'), 'origin')).toEqual({ remote: 'new', checked: false, track: true });
  });
});

describe('pullRequestFor', () => {
  const pr = (n: number): PullRequestInfo => ({ number: n, title: 't', url: `https://github.com/o/r/pull/${n}`, state: 'open', headRef: 'x', baseRef: 'main', updatedAt: 0 });
  const list: PullRequestList = { status: 'ok', byRef: { 'refs/heads/x': pr(1), 'refs/remotes/origin/y': pr(2) } };

  it('finds the PR by the remote branch, or by the local branch when it is the upstream', () => {
    expect(pullRequestFor(list, head('x', { upstream: 'origin/x' }), 'origin', 'x')?.pr.number).toBe(1);
    expect(pullRequestFor(list, head('x', { upstream: 'origin/x' }), 'origin', 'y')).toMatchObject({ ref: 'refs/remotes/origin/y' });
    expect(pullRequestFor(list, head('x'), 'origin', 'x')).toBeUndefined();
    expect(pullRequestFor(null, head('x'), 'origin', 'x')).toBeUndefined();
  });
});
