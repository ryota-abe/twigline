import { describe, expect, it } from 'vitest';
import type { PullRequestInfo, PullRequestList, RefInfo } from '../../shared/protocol';
import { pullRequestFor, pushStatus } from '../../webview/src/util/pushStatus';

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
