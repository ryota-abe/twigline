import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addOther,
  hasOther,
  isTrustedRoot,
  MAX_OTHER_REPOSITORIES,
  othersStorageKey,
  removeOther,
  sanitizeOthers,
} from '../../src/repo/otherRepositories';
import { isSameOrInside } from '../../src/repo/repoId';
import { repoStatusFromWorkingTree } from '../../src/repo/repoStatus';
import { headChanged, StatusPoller, statusFingerprint } from '../../src/repo/statusPoller';
import { makeRepo, openModel, type TempRepo } from './helpers';

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

  it('trusts anything inside a workspace folder, but only the exact roots of other and vscode.git repositories', () => {
    const ctx = { workspaceFolders: [abs('ws')], gitRoots: [abs('git', 'repo')], others: [abs('home'), abs('other', 'repo')] };
    expect(isTrustedRoot(abs('ws'), ctx)).toBe(true);
    expect(isTrustedRoot(abs('ws', 'vendor', 'lib'), ctx)).toBe(true);
    expect(isTrustedRoot(abs('git', 'repo'), ctx)).toBe(true);
    expect(isTrustedRoot(abs('other', 'repo'), ctx)).toBe(true);
    // A repository inside a trusted one is a different repository with its own settings
    expect(isTrustedRoot(abs('home', 'downloads', 'evil'), ctx)).toBe(false);
    expect(isTrustedRoot(abs('git', 'repo', 'fixture'), ctx)).toBe(false);
    // A repository that contains a workspace folder is not covered by Workspace Trust
    expect(isTrustedRoot(abs(), ctx)).toBe(false);
    expect(isTrustedRoot(abs('elsewhere'), { workspaceFolders: [], gitRoots: [], others: [] })).toBe(false);
  });

  it.runIf(process.platform === 'win32')('compares roots without case on Windows', () => {
    const ctx = { workspaceFolders: [], gitRoots: [], others: ['C:\\Repos\\App'] };
    expect(isTrustedRoot('c:\\repos\\app', ctx)).toBe(true);
    expect(isTrustedRoot('c:\\repos\\app\\sub', ctx)).toBe(false);
  });

  it('keys the list by the machine in a remote window', () => {
    expect(othersStorageKey({ hostname: 'pc' })).toBe('twigline.otherRepositories');
    expect(othersStorageKey({ remoteName: 'ssh-remote', hostname: 'build1' })).toBe('twigline.otherRepositories:ssh-remote:build1');
    expect(othersStorageKey({ remoteName: 'ssh-remote', hostname: 'build2' })).not.toBe(othersStorageKey({ remoteName: 'ssh-remote', hostname: 'build1' }));
    // WSL distributions share the host name of Windows
    expect(othersStorageKey({ remoteName: 'wsl', hostname: 'pc', wslDistro: 'Ubuntu' })).not.toBe(othersStorageKey({ remoteName: 'wsl', hostname: 'pc', wslDistro: 'Debian' }));
  });
});

describe('other repositories: state', () => {
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

  it('counts conflicts and the stopped merge', async () => {
    const r = makeRepo();
    repos.push(r);
    r.commit('init', { 'a.txt': 'a\n' });
    r.git(['switch', '-q', '-c', 'side']);
    r.commit('side', { 'a.txt': 'side\n' });
    r.git(['switch', '-q', 'main']);
    r.commit('main', { 'a.txt': 'main\n' });
    expect(() => r.git(['merge', '-q', 'side'])).toThrow();
    const model = await openModel(r.dir);
    try {
      const s = repoStatusFromWorkingTree(model.gitDir, await model.status.getParsed());
      expect(s).toMatchObject({ conflicts: 1, changed: 1, sequence: { kind: 'merge' } });
    } finally {
      model.dispose();
    }
  });

  it('tells a moved HEAD apart from a working tree change', async () => {
    const r = makeRepo();
    repos.push(r);
    r.commit('init', { 'a.txt': 'a\n' });
    const model = await openModel(r.dir);
    try {
      const read = async () => {
        model.status.invalidate();
        return statusFingerprint(model.root, model.gitDir, await model.status.getParsed());
      };
      const first = await read();
      r.write('a.txt', 'changed\n');
      const changed = await read();
      expect(headChanged(first, changed)).toBe(false);
      r.commit('second', { 'a.txt': 'changed\n' });
      expect(headChanged(changed, await read())).toBe(true);
    } finally {
      model.dispose();
    }
  });

  it('fingerprints the status so that editing an already modified file is noticed', async () => {
    const r = makeRepo();
    repos.push(r);
    r.commit('init', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    r.write('a.txt', 'changed\n');
    const model = await openModel(r.dir);
    try {
      const read = async () => {
        model.status.invalidate();
        return statusFingerprint(model.root, model.gitDir, await model.status.getParsed());
      };
      const first = await read();
      expect(await read()).toBe(first);
      // Still "M", but the content (and size) changed
      r.write('a.txt', 'changed once more\n');
      const edited = await read();
      expect(edited).not.toBe(first);
      r.git(['add', 'a.txt']);
      const staged = await read();
      expect(staged).not.toBe(edited);
      r.write('new.txt', 'new\n');
      expect(await read()).not.toBe(staged);
    } finally {
      model.dispose();
    }
  });
});

describe('StatusPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (fingerprints: (string | undefined)[], tookMs = 0) => {
    let i = 0;
    const read = vi.fn(async () => {
      if (tookMs) await new Promise((res) => setTimeout(res, tookMs));
      return fingerprints[Math.min(i++, fingerprints.length - 1)];
    });
    const onChange = vi.fn();
    const poller = new StatusPoller({ read, onChange, minIntervalMs: 5_000, maxIntervalMs: 60_000, factor: 20, debounceMs: 150 });
    return { poller, read, onChange };
  };

  it('takes the first read as the baseline and reports only a different result', async () => {
    const { poller, read, onChange } = setup(['a', 'a', 'b', 'b']);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('polls only while active, at an interval that follows how long the read took', async () => {
    const { poller, read } = setup(['a'], 1_000);
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(150 + 1_000);
    expect(read).toHaveBeenCalledTimes(1);
    // 1s × 20 = 20s until the next read
    await vi.advanceTimersByTimeAsync(19_000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000 + 1_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.setActive(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it('keeps the minimum interval for a fast read, and an event pending when it becomes inactive', async () => {
    const { poller, read } = setup(['a']);
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.poke();
    poller.setActive(false);
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(3);
    poller.dispose();
  });

  it('reads again after the current read when an event comes meanwhile', async () => {
    const { poller, read, onChange } = setup(['a', 'b'], 1_000);
    poller.poke();
    await vi.advanceTimersByTimeAsync(500);
    poller.poke();
    // The first read ends at 1150ms, the second starts 150ms later and takes 1s
    await vi.advanceTimersByTimeAsync(650 + 150 + 1_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    poller.dispose();
  });

  it('reports a change made during a silent read after an event', async () => {
    // resync -> silent read of 'b' (the change the panel was told about); a save meanwhile -> 'c' must be reported
    const { poller, read, onChange } = setup(['a', 'b', 'c'], 1_000);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150 + 1_000);
    poller.resync();
    await vi.advanceTimersByTimeAsync(150 + 500);
    poller.poke();
    await vi.advanceTimersByTimeAsync(500 + 150 + 1_000);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map((c) => (c as unknown as [{ resync: boolean }])[0].resync)).toEqual([false, true, false]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b', 'c');
    poller.dispose();
  });

  it('keeps a resync silent while a periodic read is pending, but not an event that came before it', async () => {
    const { poller, read, onChange } = setup(['a', 'b', 'c']);
    poller.setActive(true);
    await vi.advanceTimersByTimeAsync(150);
    // The periodic read is due in 5s; a resync replaces it with a silent read
    poller.resync();
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).not.toHaveBeenCalled();
    // An event, then a resync before it is read: the read stays a normal one
    poller.poke();
    poller.resync();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenCalledWith('b', 'c');
    poller.dispose();
  });

  it('ignores a read that finishes after dispose', async () => {
    const { poller, onChange } = setup(['a', 'b'], 1_000);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150 + 1_000);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150 + 500);
    poller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('skips a read that returns nothing and takes a new baseline silently on resync', async () => {
    const { poller, read, onChange } = setup(['a', undefined, 'b', 'c']);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
    poller.resync();
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).not.toHaveBeenCalled();
    poller.poke();
    await vi.advanceTimersByTimeAsync(150);
    expect(onChange).toHaveBeenCalledTimes(1);
    poller.dispose();
    poller.poke();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(4);
  });
});
