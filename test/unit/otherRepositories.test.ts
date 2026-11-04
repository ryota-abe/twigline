import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeKind } from '../../shared/protocol';
import { addOther, hasOther, isSameOrInside, isWorktreeChange, MAX_OTHER_REPOSITORIES, removeOther, sanitizeOthers } from '../../src/repo/otherRepositories';
import { repoStatusFromWorkingTree } from '../../src/repo/repoStatus';
import { makeRepo, openModel, testEnv, type TempRepo } from './helpers';

const abs = (...parts: string[]) => path.resolve(path.sep, ...parts);

describe('list of other repositories', () => {
  it('drops stored values that are not entries, relative paths and duplicates', () => {
    expect(sanitizeOthers(undefined)).toEqual([]);
    expect(sanitizeOthers('x')).toEqual([]);
    expect(
      sanitizeOthers([
        { root: abs('a'), lastOpened: 2 },
        { root: 'relative', lastOpened: 1 },
        null,
        { root: abs('a'), lastOpened: 3 },
        { root: abs('b'), lastOpened: 'x' },
      ]),
    ).toEqual([
      { root: abs('a'), lastOpened: 2 },
      { root: abs('b'), lastOpened: 0 },
    ]);
  });

  it('moves a repository opened again to the top and drops the oldest when full', () => {
    let list = addOther([], abs('a'), 1);
    list = addOther(list, abs('b'), 2);
    list = addOther(list, abs('a'), 3);
    expect(list.map((o) => o.root)).toEqual([abs('a'), abs('b')]);
    expect(list[0].lastOpened).toBe(3);

    for (let i = 0; i < MAX_OTHER_REPOSITORIES + 5; i++) list = addOther(list, abs(`r${i}`), 10 + i);
    expect(list).toHaveLength(MAX_OTHER_REPOSITORIES);
    expect(hasOther(list, abs('a'))).toBe(false);
    expect(hasOther(list, abs(`r${MAX_OTHER_REPOSITORIES + 4}`))).toBe(true);
  });

  it('removes a repository', () => {
    const list = addOther(addOther([], abs('a'), 1), abs('b'), 2);
    expect(removeOther(list, abs('a')).map((o) => o.root)).toEqual([abs('b')]);
    expect(hasOther(removeOther(list, abs('a')), abs('a'))).toBe(false);
  });

  it('tells whether a path is a folder or inside it', () => {
    expect(isSameOrInside(abs('ws'), abs('ws'))).toBe(true);
    expect(isSameOrInside(abs('ws', 'sub', 'x'), abs('ws'))).toBe(true);
    expect(isSameOrInside(abs('ws2'), abs('ws'))).toBe(false);
    expect(isSameOrInside(abs('ws'), abs('ws', 'sub'))).toBe(false);
    expect(isSameOrInside(abs('x'), path.sep)).toBe(true);
  });

  it('refreshes the status for working tree changes but not for the git directory', () => {
    expect(isWorktreeChange('src/a.ts')).toBe(true);
    expect(isWorktreeChange(path.join('src', 'a.ts'))).toBe(true);
    expect(isWorktreeChange('.gitignore')).toBe(true);
    expect(isWorktreeChange('sub/.git/index')).toBe(true);
    expect(isWorktreeChange('.git')).toBe(false);
    expect(isWorktreeChange(path.join('.git', 'index'))).toBe(false);
    expect(isWorktreeChange(path.join('..', 'other', 'a.ts'))).toBe(false);
    expect(isWorktreeChange('')).toBe(false);
  });
});

describe('other repositories: state and watching', () => {
  const repos: TempRepo[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) r.cleanup();
  });

  it('counts the state of the repository list from git status', async () => {
    const r = makeRepo();
    repos.push(r);
    r.commit('init', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.write('a.txt', 'changed\n');
    r.git(['add', 'a.txt']);
    r.write('a.txt', 'changed again\n');
    r.write('b.txt', 'changed\n');
    r.write('new.txt', 'new\n');
    const model = await openModel(r.dir);
    try {
      const s = repoStatusFromWorkingTree(model.gitDir, await model.status.getParsed());
      expect(s).toMatchObject({ conflicts: 0, staged: 1, unstaged: 2, untracked: 1, changed: 3, sequence: null });
    } finally {
      model.dispose();
    }
  });

  it('watches the working tree only when asked, and ignores the git directory there', async () => {
    const r = makeRepo();
    repos.push(r);
    r.commit('init', { 'a.txt': 'a\n' });
    const watchers = new Map<string, (abs: string) => void>();
    const env = testEnv({
      watch: (dir, onChange) => {
        watchers.set(dir, onChange);
        return { dispose: () => watchers.delete(dir) };
      },
    });
    const model = await openModel(r.dir, env);
    try {
      model.startWatching(true);
      expect(watchers.has(model.root)).toBe(false);
      model.stopWatching();

      model.startWatching(true, { worktree: true });
      expect(watchers.has(model.root)).toBe(true);
      const changes: ChangeKind[][] = [];
      const sub = model.onDidChange((kinds) => changes.push([...kinds]));
      watchers.get(model.root)!(path.join(model.root, '.git', 'index.lock'));
      await new Promise((res) => setTimeout(res, 400));
      expect(changes).toEqual([]);
      watchers.get(model.root)!(path.join(model.root, 'a.txt'));
      for (let i = 0; i < 50 && changes.length === 0; i++) await new Promise((res) => setTimeout(res, 100));
      expect(changes).toEqual([['status']]);
      sub.dispose();
      model.stopWatching();
      expect(watchers.has(model.root)).toBe(false);
    } finally {
      model.dispose();
    }
  });
});
