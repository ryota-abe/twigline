import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isOutside, type RepoModel } from '../../src/repo/RepoModel';
import { autostashConflicted } from '../../src/services/OpsService';
import { absolutePath } from '../../webview/src/util/paths';
import { makeRepo, openModel, testEnv, type TempRepo } from './helpers';

// Checks that keep an operation from touching something other than what the user was shown

const repos: TempRepo[] = [];
const models: RepoModel[] = [];
function repo(): TempRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
async function model(r: TempRepo): Promise<RepoModel> {
  const m = await openModel(r.dir, testEnv());
  models.push(m);
  return m;
}
afterEach(async () => {
  for (const m of models.splice(0)) m.dispose();
  // On Windows it takes a moment until a terminated git releases the directory
  for (const r of repos.splice(0)) {
    for (let i = 0; ; i++) {
      try {
        r.cleanup();
        break;
      } catch (e) {
        if (i >= 20) throw e;
        await new Promise((res) => setTimeout(res, 150));
      }
    }
  }
});

/** A repository with origin/main fetched */
function withOrigin(): TempRepo {
  const up = makeRepo({ bare: true });
  repos.push(up);
  const r = repo();
  r.commit('one');
  r.git(['remote', 'add', 'origin', up.dir]);
  r.git(['push', '-q', '-u', 'origin', 'main']);
  return r;
}

describe('branches started from a remote branch', () => {
  it('do not track a remote branch with another name', async () => {
    const r = withOrigin();
    const m = await model(r);
    await m.ops.run({ kind: 'branch/create', name: 'feature', start: 'origin/main', checkout: true });
    await m.ops.run({ kind: 'branch/create', name: 'other', start: 'origin/main', checkout: false });
    expect(r.git(['config', '--list']).split('\n').filter((l) => /^branch\.(feature|other)\./.test(l))).toEqual([]);
    // Committing and pushing from it goes to a branch of its own name, not to origin/main
    expect(await m.commit.pushTarget()).toEqual({ branch: 'feature', remote: 'origin', remoteBranch: 'feature', setUpstream: true });
  });

  it('still track the remote branch of the same name', async () => {
    const r = withOrigin();
    r.git(['checkout', '-q', '--detach']);
    r.git(['branch', '-D', 'main']);
    const m = await model(r);
    await m.ops.run({ kind: 'branch/create', name: 'main', start: 'origin/main', checkout: true });
    expect(r.git(['rev-parse', '--abbrev-ref', 'main@{upstream}']).trim()).toBe('origin/main');
  });
});

describe('stashes addressed by index', () => {
  it('refuses to apply, drop or branch when another stash has taken the index', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '1\n' });
    r.write('f.txt', 'chosen\n');
    r.git(['stash', 'push', '-q', '-m', 'chosen']);
    const m = await model(r);
    const chosen = (await m.snapshot.get()).stashes[0];
    // The list shifts after the user saw it (an autostash, a stash made in a terminal)
    r.write('f.txt', 'newer\n');
    r.git(['stash', 'push', '-q', '-m', 'newer']);

    await expect(m.ops.run({ kind: 'stash/drop', index: 0, sha: chosen.sha })).rejects.toMatchObject({ category: 'invalid' });
    await expect(m.ops.run({ kind: 'stash/apply', index: 0, sha: chosen.sha, drop: true, restoreIndex: false })).rejects.toMatchObject({ category: 'invalid' });
    await expect(m.ops.run({ kind: 'stash/branch', index: 0, sha: chosen.sha, name: 'b' })).rejects.toMatchObject({ category: 'invalid' });
    expect(r.git(['stash', 'list', '--format=%s']).trim().split('\n')).toEqual(['On main: newer', 'On main: chosen']);

    // Where it is now, it is the one that goes
    await m.ops.run({ kind: 'stash/drop', index: 1, sha: chosen.sha });
    expect(r.git(['stash', 'list', '--format=%s']).trim()).toBe('On main: newer');
  });
});

describe('interactive rebase', () => {
  it('refuses a base that is not an ancestor of HEAD', async () => {
    const r = repo();
    r.commit('base');
    r.git(['checkout', '-q', '-b', 'other']);
    const foreign = r.commit('other', { 'o.txt': 'o\n' });
    r.git(['checkout', '-q', 'main']);
    const a = r.commit('A', { 'a.txt': 'a\n' });
    const m = await model(r);
    await expect(m.rebase.commits(foreign)).rejects.toMatchObject({ category: 'invalid' });
    await expect(m.ops.run({ kind: 'rebase/interactive', base: foreign, todo: [{ action: 'pick', sha: a, subject: 'A' }] })).rejects.toMatchObject({ category: 'invalid' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['rev-parse', 'HEAD']).trim()).toBe(a);
  });

  it('refuses a todo listed before HEAD moved, instead of dropping the new commit', async () => {
    const r = repo();
    const base = r.commit('base');
    const a = r.commit('A', { 'a.txt': 'a\n' });
    const m = await model(r);
    const list = await m.rebase.commits(base);
    const b = r.commit('B', { 'b.txt': 'b\n' });
    await expect(
      m.ops.run({ kind: 'rebase/interactive', base, todo: list.map((c) => ({ action: 'reword' as const, sha: c.sha, subject: c.subject, message: 'A2' })) }),
    ).rejects.toMatchObject({ category: 'invalid' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['rev-parse', 'HEAD']).trim()).toBe(b);
    expect(r.git(['log', '--format=%s', `${base}..HEAD`]).trim().split('\n')).toEqual(['B', 'A']);
    expect(a).toBe(list[0].sha);
  });
});

describe('revert of several commits', () => {
  it('reverts them in the order given, one commit each', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '0\n' });
    const a = r.commit('A', { 'f.txt': '1\n' });
    const b = r.commit('B', { 'f.txt': '2\n' });
    const m = await model(r);
    const res = await m.ops.run({ kind: 'revert', shas: [b, a] });
    expect(res.stopped).toBeUndefined();
    expect(r.read('f.txt').toString()).toBe('0\n');
    expect(r.git(['log', '--format=%s', '-2']).trim().split('\n')).toEqual(['Revert "A"', 'Revert "B"']);
  });
});

describe('autostash', () => {
  it('reports the conflict when the changes set aside do not go back, and marks the operation in progress', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n', 'g.txt': 'g\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    r.commit('other', { 'f.txt': 'other\n' });
    r.git(['checkout', '-q', 'main']);
    r.write('f.txt', 'local\n');
    const m = await model(r);
    const res = await m.ops.run({ kind: 'merge', ref: 'other', noFastForward: false, squash: false, commit: true, autostash: true });
    if (!m.features.pullAutostash) return;
    // Reported whenever git left conflicts behind (whatever it printed), together with the stash that keeps the changes
    expect(r.git(['ls-files', '--unmerged']).trim()).not.toBe('');
    expect(res.autostashConflict).toBe(true);
    expect(r.git(['stash', 'list']).trim()).toContain('autostash');

    // A merge that stops on a conflict keeps the changes set aside until it ends
    r.git(['checkout', '-q', '-f', 'main']);
    r.git(['reset', '-q', '--hard', 'main~1']);
    r.commit('main', { 'f.txt': 'main\n' });
    r.write('g.txt', 'local g\n');
    await m.ops.run({ kind: 'merge', ref: 'other', noFastForward: false, squash: false, commit: true, autostash: true }).catch(() => undefined);
    expect(m.snapshot.readSequence()).toMatchObject({ kind: 'merge', autostash: true });
  });

  it('recognizes the message of git', () => {
    expect(autostashConflicted('Applying autostash resulted in conflicts.\nYour changes are safe in the stash.\n')).toBe(true);
    expect(autostashConflicted('Applied autostash.\n')).toBe(false);
  });
});

describe('ignored files in the way of incoming commits', () => {
  it('are reported, alone or under an ignored directory, and only when they exist', async () => {
    const r = repo();
    r.commit('base', { '.gitignore': 'secret.env\nbuild/\n', 'f.txt': '1\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    r.commit('other', { 'f.txt': '2\n' });
    r.write('secret.env', 'theirs\n');
    r.write('build/out.txt', 'theirs\n');
    r.write('build/absent.txt', 'theirs\n');
    r.git(['add', '-f', 'secret.env', 'build/out.txt', 'build/absent.txt']);
    r.git(['commit', '-q', '-m', 'adds ignored paths']);
    r.git(['checkout', '-q', 'main']);
    r.write('secret.env', 'mine\n');
    r.write('build/out.txt', 'mine\n');
    const m = await model(r);
    const cmp = await m.compare.compare('main', 'other', { files: true });
    expect(cmp?.incomingIgnored).toEqual(['build/out.txt', 'secret.env']);
    expect(existsSync(path.join(r.dir, 'build/absent.txt'))).toBe(false);
  });
});

describe('paths', () => {
  it('takes a name that starts with two dots as inside its base', () => {
    expect(isOutside('..foo')).toBe(false);
    expect(isOutside(path.join('..foo', 'a.txt'))).toBe(false);
    expect(isOutside('..')).toBe(true);
    expect(isOutside(path.join('..', 'a.txt'))).toBe(true);
    expect(isOutside('..\\a.txt')).toBe(true);
  });

  it('opens a file whose name starts with two dots', async () => {
    const r = repo();
    r.commit('base', { '..notes.txt': 'n\n' });
    const m = await model(r);
    expect(m.resolvePath('..notes.txt')).toBe(path.join(m.root, '..notes.txt'));
    expect(() => m.resolvePath('../x')).toThrow();
  });

  it('copies a path with the separator of the OS', () => {
    expect(absolutePath('C:\\repo', 'src/a.ts')).toBe('C:\\repo\\src\\a.ts');
    expect(absolutePath('C:\\repo\\', 'a.ts')).toBe('C:\\repo\\a.ts');
    expect(absolutePath('/home/me/repo', 'src/a.ts')).toBe('/home/me/repo/src/a.ts');
  });
});
