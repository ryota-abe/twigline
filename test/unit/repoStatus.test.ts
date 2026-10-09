import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countBadge, repoStatus } from '../../src/repo/repoStatus';
import { findGitDir } from '../../src/repo/sequence';
import { makeRepo, type TempRepo } from './helpers';

const change = (p: string) => ({ uri: { toString: () => `file://${p}` } }) as never;

describe('repository list status (without running git)', () => {
  const repos: TempRepo[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) r.cleanup();
  });
  const repo = () => {
    const r = makeRepo();
    repos.push(r);
    return r;
  };

  it('finds the git directory of a repository and of a linked worktree', () => {
    const r = repo();
    r.commit('init', { 'a.txt': 'a\n' });
    expect(findGitDir(r.dir)).toBe(path.join(r.dir, '.git'));
    const wt = path.join(r.dir, 'wt');
    r.git(['worktree', 'add', '-b', 'side', wt]);
    expect(realpathSync(findGitDir(wt)!)).toBe(realpathSync(path.join(r.dir, '.git', 'worktrees', 'wt')));
    expect(findGitDir(path.join(r.dir, 'missing'))).toBeUndefined();
  });

  it('counts each changed file once and reads the operation in progress', () => {
    const r = repo();
    r.commit('init', { 'a.txt': 'a\n' });
    r.git(['checkout', '-b', 'feature']);
    r.commit('feature', { 'a.txt': 'feature\n' });
    r.git(['checkout', 'main']);
    r.commit('main', { 'a.txt': 'main\n' });
    expect(repoStatus(r.dir, undefined).sequence).toBeNull();
    try {
      r.git(['merge', 'feature']);
    } catch {
      // Stops on the conflict
    }
    const s = repoStatus(r.dir, {
      mergeChanges: [change('/r/a.txt')],
      indexChanges: [change('/r/b.txt')],
      workingTreeChanges: [change('/r/b.txt'), change('/r/c.txt')],
      untrackedChanges: [],
    });
    expect(s).toMatchObject({ conflicts: 1, staged: 1, unstaged: 2, untracked: 0, changed: 3 });
    expect(s.sequence?.kind).toBe('merge');
  });

  it('fits the count into a two-character badge', () => {
    expect(countBadge(0)).toBeUndefined();
    expect(countBadge(7)).toBe('7');
    expect(countBadge(99)).toBe('99');
    expect(countBadge(100)).toBe('9+');
  });
});
