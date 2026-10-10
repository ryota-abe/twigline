import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Operation } from '../../shared/protocol';
import { GitError } from '../../src/git/errors';
import { GitHelpers } from '../../src/ipc/helpers';
import type { RepoModel } from '../../src/repo/RepoModel';
import { makeRepo, openModel, testEnv, type TempRepo } from './helpers';

const repos: TempRepo[] = [];
const models: RepoModel[] = [];
function repo(): TempRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
async function model(r: TempRepo, env = testEnv()): Promise<RepoModel> {
  const m = await openModel(r.dir, env);
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

const distReady = existsSync(path.resolve(__dirname, '../../dist/editor-main.js'));
beforeAll(() => {
  if (!distReady) console.warn('dist/ not found; skipping tests that use the helpers (npm run build:host)');
});

/** Create many commits quickly with fast-import */
function manyCommits(r: TempRepo, n: number): void {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const msg = `commit ${i}`;
    lines.push('commit refs/heads/main', `mark :${i}`, `committer T <t@e> ${1_700_000_000 + i} +0000`, `data ${Buffer.byteLength(msg)}`, msg);
    if (i > 1) lines.push(`from :${i - 1}`);
    lines.push(`M 644 inline f.txt`, `data ${String(i).length + 1}`, `${i}`, '');
  }
  r.git(['fast-import', '--quiet'], { input: lines.join('\n') + '\n' });
  r.git(['reset', '-q', '--hard', 'main']);
}

describe('LogService', () => {
  it('pages through a streaming git log and recreates expired cursors with --skip', async () => {
    const r = repo();
    manyCommits(r, 1200);
    const m = await model(r);
    const q = { branches: 'all' as const, includeRemotes: true, includeStashes: false, order: 'date' as const };
    const p1 = await m.log.page(q, undefined, 0, 500);
    expect(p1.rows).toHaveLength(500);
    expect(p1.rows[0].subject).toBe('commit 1200');
    expect(p1.done).toBe(false);
    const p2 = await m.log.page(q, p1.cursor!, 500, 500);
    expect(p2.rows[0].subject).toBe('commit 700');
    const p3 = await m.log.page(q, p2.cursor!, 1000, 500);
    expect(p3.rows).toHaveLength(200);
    expect(p3.done).toBe(true);
    expect(p3.cursor).toBeNull();
    // If the cursor was lost, recreate from offset
    const again = await m.log.page(q, 'missing', 1100, 50);
    expect(again.rows[0].subject).toBe('commit 100');
  });

  it('searches, follows file history and handles unborn repositories', async () => {
    const r = repo();
    const m0 = await model(r);
    const empty = await m0.log.page({ branches: 'all', includeRemotes: true, includeStashes: false, order: 'date' }, undefined, 0, 10);
    expect(empty.rows).toEqual([]);
    expect(empty.done).toBe(true);

    r.commit('add a', { 'a.txt': '1\n' });
    r.commit('ログイン画面', { 'b.txt': '1\n' });
    r.commit('change a', { 'a.txt': '2\n' });
    const m = await model(r);
    const base = { branches: 'all' as const, includeRemotes: true, includeStashes: false, order: 'date' as const };
    const found = await m.log.page({ ...base, search: { mode: 'message', text: 'ログイン' } }, undefined, 0, 10);
    expect(found.rows.map((x) => x.subject)).toEqual(['ログイン画面']);
    const hist = await m.log.page({ ...base, path: 'a.txt' }, undefined, 0, 10);
    expect(hist.rows.map((x) => x.subject)).toEqual(['change a', 'add a']);
    // With a path, parents are rewritten and the graph is connected
    expect(hist.rows[0].parents).toEqual([hist.rows[1].sha]);

    // Follow renames (--follow)
    r.git(['mv', 'a.txt', 'renamed.txt']);
    r.commit('rename a');
    const follow = await m.log.page({ ...base, path: 'renamed.txt', follow: true }, undefined, 0, 10);
    expect(follow.rows.map((x) => x.subject)).toEqual(['rename a', 'change a', 'add a']);
    const noFollow = await m.log.page({ ...base, path: 'renamed.txt', follow: false }, undefined, 0, 10);
    expect(noFollow.rows.map((x) => x.subject)).toEqual(['rename a']);
  });

  it('shows stashes with only their first parent', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '1\n' });
    r.write('f.txt', '2\n');
    r.write('u.txt', 'untracked\n');
    r.git(['stash', 'push', '-u', '-q', '-m', 'wip']);
    const m = await model(r);
    const page = await m.log.page({ branches: 'all', includeRemotes: true, includeStashes: true, order: 'date' }, undefined, 0, 50);
    const snap = await m.snapshot.get();
    const stashRow = page.rows.find((x) => x.sha === snap.stashes[0].sha)!;
    expect(stashRow.parents).toEqual([snap.head.sha]);
    expect(page.rows).toHaveLength(2); // The index and untracked commits are not shown
  });
});

describe('SnapshotService', () => {
  it('reports head, refs, remotes, stashes and a merge in progress', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n' });
    r.git(['checkout', '-q', '-b', 'feature/login']);
    r.commit('feature', { 'f.txt': 'feature\n' });
    r.git(['checkout', '-q', 'main']);
    r.commit('main', { 'f.txt': 'main\n' });
    r.git(['remote', 'add', 'origin', 'https://user:secret@example.com/r.git']);
    try {
      r.git(['merge', 'feature/login']);
    } catch {
      /* Conflict */
    }
    const m = await model(r);
    const snap = await m.snapshot.get();
    expect(snap.head).toMatchObject({ branch: 'main', detached: false, unborn: false });
    expect(snap.refs.map((x) => x.name).sort()).toEqual(['feature/login', 'main']);
    expect(snap.remotes[0].name).toBe('origin');
    expect(snap.sequence).toMatchObject({ kind: 'merge', incomingName: 'feature/login' });
    const st = await m.status.get();
    expect(st.conflicted.map((f) => f.path)).toEqual(['f.txt']);
  });

  it('handles unborn and detached HEAD', async () => {
    const r = repo();
    let m = await model(r);
    let snap = await m.snapshot.get();
    expect(snap.head).toMatchObject({ unborn: true, branch: 'main', sha: null });
    const c = r.commit('one');
    r.git(['checkout', '-q', '--detach', c]);
    m = await model(r);
    snap = await m.snapshot.get();
    expect(snap.head).toMatchObject({ detached: true, branch: null, sha: c });
  });
});

describe('DiffService + StageService', () => {
  it('stages and unstages selected lines and rejects stale diffs', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'a\nb\nc\n' });
    r.write('f.txt', 'a\nB\nc\nd\n');
    const m = await model(r);
    const diff = await m.diff.get({ target: { kind: 'worktree' }, path: 'f.txt', context: 3, ignoreWhitespace: false });
    expect(diff.lineOps).toBe(true);
    expect(diff.encoding).toBe('UTF-8');
    const dLine = diff.hunks[0].lines.find((l) => l.text === 'd')!;
    await m.stage.applyLines(diff.diffId, [dLine.id], 'stage');
    expect(r.git(['show', ':f.txt'])).toBe('a\nb\nc\nd\n');

    const staged = await m.diff.get({ target: { kind: 'index' }, path: 'f.txt', context: 3, ignoreWhitespace: false });
    const plusD = staged.hunks[0].lines.find((l) => l.text === 'd')!;
    await m.stage.applyLines(staged.diffId, [plusD.id], 'unstage');
    expect(r.git(['show', ':f.txt'])).toBe('a\nb\nc\n');

    const d2 = await m.diff.get({ target: { kind: 'worktree' }, path: 'f.txt', context: 3, ignoreWhitespace: false });
    r.write('f.txt', 'changed meanwhile\n');
    await expect(m.stage.applyLines(d2.diffId, [d2.hunks[0].lines.find((l) => l.kind !== ' ')!.id], 'stage')).rejects.toMatchObject({
      category: 'stale',
    });
  });

  it('decodes Shift_JIS with auto guess and stages a partial untracked file', async () => {
    const r = repo();
    r.commit('base');
    r.write('sjis.txt', Buffer.from('\x82\xa0\x82\xa2\x82\xa4\x82\xa6\x82\xa8\r\n\x93\xfa\x96\x7b\x8c\xea\r\n', 'latin1'));
    const m = await model(r);
    const diff = await m.diff.get({ target: { kind: 'worktree' }, path: 'sjis.txt', context: 3, ignoreWhitespace: false, untracked: true });
    expect(diff.fileMode).toBe('untracked');
    expect(diff.encoding).toBe('Shift_JIS');
    expect(diff.hunks[0].lines.map((l) => l.text)).toEqual(['あいうえお', '日本語']);
    expect(diff.hunks[0].lines[0].crlf).toBe(true);
    await m.stage.applyLines(diff.diffId, [diff.hunks[0].lines[1].id], 'stage');
    expect(r.gitBuf(['show', ':sjis.txt']).equals(Buffer.from('\x93\xfa\x96\x7b\x8c\xea\r\n', 'latin1'))).toBe(true);
  });

  it('stages and unstages whole files, including in an unborn repository', async () => {
    const r = repo();
    r.write('a b.txt', 'x\n');
    r.write('[glob].txt', 'y\n');
    r.write('g.txt', 'must not be matched by the [glob] pattern\n');
    const m = await model(r);
    await m.stage.stagePaths(['a b.txt', '[glob].txt']);
    expect(r.git(['diff', '--cached', '--name-only']).trim().split('\n').sort()).toEqual(['[glob].txt', 'a b.txt']);
    await m.stage.unstagePaths(['[glob].txt']);
    expect(r.git(['diff', '--cached', '--name-only']).trim()).toBe('a b.txt');
  });

  it('returns commit details with renames and merge parents', async () => {
    const r = repo();
    r.commit('base', { 'x.txt': Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n' });
    r.git(['mv', 'x.txt', 'y.txt']);
    const sha = r.commit('rename');
    const m = await model(r);
    const d = await m.diff.commitDetail(sha, undefined, undefined);
    expect(d.message).toBe('rename');
    expect(d.files).toEqual([{ path: 'y.txt', oldPath: 'x.txt', status: 'R', additions: 0, deletions: 0 }]);
    const fd = await m.diff.get({ target: { kind: 'commit', sha }, path: 'y.txt', oldPath: 'x.txt', context: 3, ignoreWhitespace: false });
    expect(fd.hunks).toEqual([]);
    expect(fd.lineOps).toBe(false);
  });
});

describe('OpsService', () => {
  it('previews commands without running them (dryRun)', async () => {
    const r = repo();
    const c = r.commit('one');
    const m = await model(r);
    const res = await m.ops.run({ kind: 'reset', sha: c, mode: 'hard' }, { dryRun: true });
    expect(res.commands).toEqual([`git reset --hard --end-of-options ${c}`]);
    const push = await m.ops.run(
      { kind: 'push', remote: 'origin', branches: [{ local: 'main', remote: 'main', setUpstream: true }], tags: false, force: true },
      { dryRun: true },
    );
    expect(push.commands).toEqual(['git push --progress -u --force-with-lease --force-if-includes --end-of-options origin refs/heads/main:refs/heads/main']);
    // git before 2.30 does not know --force-if-includes
    (m.features as { forceIfIncludes: boolean }).forceIfIncludes = false;
    const old = await m.ops.run(
      { kind: 'push', remote: 'origin', branches: [{ local: 'main', remote: 'main', setUpstream: false }], tags: false, force: true },
      { dryRun: true },
    );
    expect(old.commands).toEqual(['git push --progress --force-with-lease --end-of-options origin refs/heads/main:refs/heads/main']);
  });

  it('rejects option-like refs (argument injection)', async () => {
    const r = repo();
    r.commit('one');
    const m = await model(r);
    await expect(m.ops.run({ kind: 'checkout', ref: '--orphan=x' }, { dryRun: true })).rejects.toBeInstanceOf(GitError);
    await expect(m.ops.run({ kind: 'branch/create', name: '-f', start: 'main', checkout: false }, { dryRun: true })).rejects.toMatchObject({ category: 'invalid' });
  });

  it('pulls into a branch that is not checked out by fast-forwarding it only', async () => {
    const up = repo();
    const base = up.commit('base', { 'f.txt': '1\n' });
    up.git(['branch', 'topic']);
    const r = repo();
    r.git(['remote', 'add', 'origin', up.dir]);
    r.git(['fetch', '-q', 'origin']);
    r.git(['checkout', '-q', '-B', 'main', 'origin/main']);
    r.git(['branch', 'topic', 'origin/topic']);
    up.git(['checkout', '-q', 'topic']);
    const next = up.commit('topic 2', { 't.txt': '1\n' });
    const m = await model(r);
    const pullTopic = { kind: 'pull', remote: 'origin', branch: 'topic', rebase: false, ffOnly: true, into: 'topic' } as const;

    const preview = await m.ops.run(pullTopic, { dryRun: true });
    expect(preview.commands).toEqual(['git fetch --progress --end-of-options origin refs/heads/topic:refs/heads/topic']);
    await m.ops.run(pullTopic);
    expect(r.git(['rev-parse', 'topic']).trim()).toBe(next);
    // Not merged into the checked-out branch
    expect(r.git(['rev-parse', 'main']).trim()).toBe(base);
    expect(r.git(['branch', '--show-current']).trim()).toBe('main');

    // If they have diverged, git refuses and the branch does not move
    r.git(['checkout', '-q', 'topic']);
    const local = r.commit('local', { 'l.txt': '1\n' });
    r.git(['checkout', '-q', 'main']);
    up.commit('topic 3', { 't.txt': '2\n' });
    await expect(m.ops.run(pullTopic)).rejects.toMatchObject({ category: 'rejected' });
    expect(r.git(['rev-parse', 'topic']).trim()).toBe(local);

    // If the target is the checked-out branch, an ordinary git pull
    const head = await m.ops.run({ kind: 'pull', remote: 'origin', branch: 'main', rebase: false, ffOnly: false, into: 'main' }, { dryRun: true });
    expect(head.commands).toEqual(['git pull --progress --no-rebase origin main']);
  });

  it('pulls over local changes in the incoming files with autostash', async () => {
    const up = repo();
    up.commit('base', { 'f.txt': '1\n2\n3\n' });
    const r = repo();
    r.git(['remote', 'add', 'origin', up.dir]);
    r.git(['fetch', '-q', 'origin']);
    r.git(['checkout', '-q', '-B', 'main', 'origin/main']);
    up.commit('remote', { 'f.txt': 'one\n2\n3\n' });
    r.write('f.txt', '1\n2\nthree\n');
    const m = await model(r);
    const pull = { kind: 'pull', remote: 'origin', branch: 'main', rebase: false, ffOnly: false } as const;
    await expect(m.ops.run(pull)).rejects.toBeInstanceOf(GitError);
    expect(r.read('f.txt').toString()).toBe('1\n2\nthree\n');

    const preview = await m.ops.run({ ...pull, autostash: true }, { dryRun: true });
    expect(preview.commands).toEqual(['git pull --progress --no-rebase --autostash origin main']);
    if (!m.features.pullAutostash) return;
    await m.ops.run({ ...pull, autostash: true });
    expect(r.read('f.txt').toString()).toBe('one\n2\nthree\n');
    expect(r.git(['stash', 'list']).trim()).toBe('');
  });

  it('merges over local changes in the incoming files with autostash', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '1\n2\n3\n' });
    r.git(['checkout', '-q', '-b', 'topic']);
    r.commit('topic', { 'f.txt': 'one\n2\n3\n' });
    r.git(['checkout', '-q', 'main']);
    r.write('f.txt', '1\n2\nthree\n');
    const m = await model(r);
    const merge = { kind: 'merge', ref: 'topic', noFastForward: false, squash: false, commit: true } as const;
    await expect(m.ops.run(merge)).rejects.toBeInstanceOf(GitError);

    const preview = await m.ops.run({ ...merge, autostash: true }, { dryRun: true });
    expect(preview.commands).toEqual(['git merge --no-edit --autostash --end-of-options topic']);
    if (!m.features.pullAutostash) return;
    await m.ops.run({ ...merge, autostash: true });
    expect(r.read('f.txt').toString()).toBe('one\n2\nthree\n');
    expect(r.git(['rev-parse', 'main']).trim()).toBe(r.git(['rev-parse', 'topic']).trim());
    expect(r.git(['stash', 'list']).trim()).toBe('');
  });

  it('creates, checks out and merges branches; reports conflicts and aborts', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n' });
    const m = await model(r);
    await m.ops.run({ kind: 'branch/create', name: 'topic', start: 'main', checkout: true });
    expect(r.git(['branch', '--show-current']).trim()).toBe('topic');
    r.commit('topic', { 'f.txt': 'topic\n' });
    await m.ops.run({ kind: 'checkout', ref: 'main' });
    r.commit('main', { 'f.txt': 'main\n' });
    const err = await m.ops.run({ kind: 'merge', ref: 'topic', noFastForward: false, squash: false, commit: true }).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.category).toBe('conflict');
    expect(m.snapshot.readSequence()?.kind).toBe('merge');
    await m.ops.run({ kind: 'conflict/resolve', paths: ['f.txt'], side: 'incoming' });
    expect(r.read('f.txt').toString()).toBe('topic\n');
    await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
  });

  it('maps current/incoming to theirs/ours while rebasing', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n' });
    r.git(['checkout', '-q', '-b', 'feature']);
    r.commit('feature', { 'f.txt': 'feature\n' });
    r.git(['checkout', '-q', 'main']);
    r.commit('main', { 'f.txt': 'main\n' });
    r.git(['checkout', '-q', 'feature']);
    const m = await model(r);
    const err = await m.ops.run({ kind: 'rebase', onto: 'main', autostash: false, updateRefs: false }).catch((e) => e);
    expect(err.category).toBe('conflict');
    expect(m.snapshot.readSequence()).toMatchObject({ kind: 'rebase', branch: 'feature' });
    // "The current branch side" is feature being rebased (theirs in git)
    await m.ops.run({ kind: 'conflict/resolve', paths: ['f.txt'], side: 'current' });
    expect(r.read('f.txt').toString()).toBe('feature\n');
    await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['log', '--format=%s', '-3']).trim().split('\n')).toEqual(['feature', 'main', 'base']);
  });

  it('classifies a dirty worktree on checkout and lists files', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n' });
    r.git(['branch', 'other']);
    r.git(['checkout', '-q', 'other']);
    r.commit('other', { 'f.txt': 'other\n' });
    r.git(['checkout', '-q', 'main']);
    r.write('f.txt', 'local change\n');
    const m = await model(r);
    const err = await m.ops.run({ kind: 'checkout', ref: 'other' }).catch((e) => e);
    expect(err.category).toBe('dirtyWorktree');
    expect(err.details.files).toEqual(['f.txt']);
  });

  it('stashes, applies and drops', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '1\n' });
    r.write('f.txt', '2\n');
    const m = await model(r);
    await m.ops.run({ kind: 'stash/push', message: 'メッセージ', keepIndex: false, includeUntracked: true, stagedOnly: false });
    expect(r.read('f.txt').toString()).toBe('1\n');
    m.snapshot.invalidate();
    expect((await m.snapshot.get()).stashes[0].message).toContain('メッセージ');
    await m.ops.run({ kind: 'stash/apply', index: 0, drop: true, restoreIndex: false });
    expect(r.read('f.txt').toString()).toBe('2\n');
  });

  it('takes untracked files out of the working tree when stashing them', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '1\n' });
    r.write('new.txt', 'n\n');
    const m = await model(r);
    await m.ops.run({ kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false });
    expect(existsSync(path.join(r.dir, 'new.txt'))).toBe(false);
    await m.ops.run({ kind: 'stash/apply', index: 0, drop: true, restoreIndex: false });
    expect(r.read('new.txt').toString()).toBe('n\n');
  });

  it('stashes ignored files in the way, and only the files in the way', async () => {
    const r = repo();
    r.commit('base', { '.gitignore': 'local.env\n', 'f.txt': '1\n' });
    r.write('local.env', 'secret\n');
    r.write('f.txt', '2\n');
    const m = await model(r);
    const op: Operation = { kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false, blockers: ['local.env'] };
    expect((await m.ops.run(op, { dryRun: true })).commands).toEqual(['git stash push --all -- local.env']);
    const res = await m.ops.run(op);
    expect(res.nothingStashed).toBeUndefined();
    expect(existsSync(path.join(r.dir, 'local.env'))).toBe(false);
    expect(r.read('f.txt').toString()).toBe('2\n');
  });

  it('keeps the usual stash when none of the files in the way is ignored', async () => {
    const r = repo();
    r.commit('base', { '.gitignore': 'local.env\n', 'f.txt': '1\n' });
    const m = await model(r);
    const op: Operation = { kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false, blockers: ['new.txt'] };
    expect((await m.ops.run(op, { dryRun: true })).commands).toEqual(['git stash push --include-untracked']);
  });

  it('marks a rebase that stopped on a file in the way, so it can be continued after a stash', async () => {
    const r = repo();
    r.commit('base', { 'a.txt': 'a\n' });
    r.git(['checkout', '-q', '-b', 'upstream']);
    r.commit('upstream', { 'u.txt': 'u\n' });
    r.git(['checkout', '-q', 'main']);
    r.commit('add local.env', { 'local.env': 'committed\n' });
    r.commit('c3', { 'b.txt': 'b\n' });
    // The ignore rule comes after the commit that tracks the file, so the file is not ignored partway through the rebase
    r.git(['rm', '-q', '--cached', 'local.env']);
    r.commit('ignore local.env', { '.gitignore': 'local.env\n' });
    r.write('local.env', 'mine\n');
    const m = await model(r);

    const err = await m.ops.run({ kind: 'rebase', onto: 'upstream', autostash: false, updateRefs: false }).catch((e) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err.category).toBe('dirtyWorktree');
    expect(err.details.files).toEqual(['local.env']);
    expect(err.details.sequenceStopped).toBe(true);
    expect(m.snapshot.readSequence()?.kind).toBe('rebase');

    // What "Stash and Continue" does: stash the file in the way, then continue the rebase instead of starting it again
    const stash = await m.ops.run({ kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false, blockers: err.details.files });
    expect(stash.nothingStashed).toBeUndefined();
    expect(existsSync(path.join(r.dir, 'local.env'))).toBe(false);
    await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['log', '--format=%s', 'upstream..main']).trim().split('\n')).toEqual(['ignore local.env', 'c3', 'add local.env']);
  });

  it('continues a cherry-pick that stopped on a file in the way without dropping that commit', async () => {
    const r = repo();
    r.commit('base', { 'a.txt': 'a\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    const shas = [r.commit('one', { 'one.txt': '1\n' }), r.commit('add x', { 'x.txt': 'x\n' }), r.commit('three', { 'three.txt': '3\n' })];
    r.git(['checkout', '-q', 'main']);
    r.write('x.txt', 'mine\n');
    const m = await model(r);

    const err = await m.ops.run({ kind: 'cherry-pick', shas, noCommit: false }).catch((e) => e);
    expect(err.category).toBe('dirtyWorktree');
    expect(err.details.sequenceStopped).toBe(true);
    // Neither CHERRY_PICK_HEAD nor REVERT_HEAD; only the sequencer is left
    expect(m.snapshot.readSequence()).toMatchObject({ kind: 'cherry-pick' });
    expect(shas[1].startsWith(m.snapshot.readSequence()!.incoming!)).toBe(true);

    await m.ops.run({ kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false, blockers: err.details.files });
    await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['log', '--format=%s']).trim().split('\n')).toEqual(['three', 'add x', 'one', 'base']);
  });

  it('continues a revert of several commits that stopped on a file in the way', async () => {
    const r = repo();
    r.commit('base', { 'a.txt': 'a\n', 'x.txt': 'x\n' });
    r.git(['rm', '-q', 'x.txt']);
    r.commit('remove x');
    r.commit('two', { 'two.txt': '2\n' });
    r.write('x.txt', 'mine\n');
    expect(() => r.git(['revert', '--no-edit', 'HEAD', 'HEAD~1'])).toThrow();
    const m = await model(r);
    expect(m.snapshot.readSequence()).toMatchObject({ kind: 'revert' });

    await m.ops.run({ kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false });
    await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['log', '--format=%s']).trim().split('\n')).toEqual(['Revert "remove x"', 'Revert "two"', 'two', 'remove x', 'base']);
  });

  it('does not apply a conflicted commit again after it was committed by hand', async () => {
    const r = repo();
    r.commit('base', { 'a.txt': 'a\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    const shas = [r.commit('one', { 'f.txt': 'theirs\n' }), r.commit('two', { 'two.txt': '2\n' })];
    r.git(['checkout', '-q', 'main']);
    r.commit('mine', { 'f.txt': 'mine\n' });
    expect(() => r.git(['cherry-pick', ...shas])).toThrow();
    r.write('f.txt', 'resolved\n');
    r.git(['add', 'f.txt']);
    r.git(['commit', '-q', '--no-edit']);
    const m = await model(r);
    expect(m.snapshot.readSequence()).toMatchObject({ kind: 'cherry-pick' });

    const res = await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(res.commands).toEqual(['git cherry-pick --continue']);
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['log', '--format=%s']).trim().split('\n')).toEqual(['two', 'one', 'mine', 'base']);
  });

  it('does not mark a cherry-pick --no-commit that stopped, which git cannot continue', async () => {
    const r = repo();
    r.commit('base', { 'a.txt': 'a\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    const shas = [r.commit('one', { 'one.txt': '1\n' }), r.commit('add x', { 'x.txt': 'x\n' })];
    r.git(['checkout', '-q', 'main']);
    r.write('x.txt', 'mine\n');
    const m = await model(r);
    const err = await m.ops.run({ kind: 'cherry-pick', shas, noCommit: true }).catch((e) => e);
    expect(err.category).toBe('dirtyWorktree');
    expect(err.details.sequenceStopped).toBeUndefined();
  });

  it('does not mark failures outside a rebase it started', async () => {
    const r = repo();
    r.commit('base', { 'a.txt': 'a\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    r.commit('add x', { 'x.txt': 'x\n' });
    r.git(['checkout', '-q', 'main']);
    r.write('x.txt', 'mine\n');
    const m = await model(r);
    const err = await m.ops.run({ kind: 'merge', ref: 'other', noFastForward: false, squash: false, commit: true }).catch((e) => e);
    expect(err.category).toBe('dirtyWorktree');
    expect(err.details.sequenceStopped).toBeUndefined();
  });

  it('reports a stash that saved nothing', async () => {
    const r = repo();
    r.commit('base', { '.gitignore': 'local.env\n', 'f.txt': '1\n' });
    r.write('local.env', 'secret\n');
    const m = await model(r);
    const res = await m.ops.run({ kind: 'stash/push', keepIndex: false, includeUntracked: true, stagedOnly: false });
    expect(res.nothingStashed).toBe(true);
    expect(existsSync(path.join(r.dir, 'local.env'))).toBe(true);
  });
});

describe('CompareService', () => {
  it('counts both sides, lists incoming files and predicts conflicts', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n', 'g.txt': 'g\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    r.commit('other 1', { 'f.txt': 'other\n' });
    r.commit('other 2', { 'new file.txt': 'n\n' });
    r.git(['checkout', '-q', 'main']);
    const m = await model(r);

    // Fast-forward: no conflicts are predicted (nothing to merge)
    const ff = await m.compare.compare('main', 'other', { files: true, conflicts: true });
    expect(ff).toMatchObject({ ahead: 0, behind: 2, incomingFiles: ['f.txt', 'new file.txt'] });
    expect(ff?.conflicts).toBeUndefined();

    r.commit('main', { 'f.txt': 'main\n' });
    const diverged = await m.compare.compare('main', 'other', { files: true, conflicts: true });
    expect(diverged).toMatchObject({ ahead: 1, behind: 2 });
    expect(diverged?.mergeBase).toBe(r.git(['merge-base', 'main', 'other']).trim());
    expect(diverged?.conflicts).toEqual(m.features.mergeTree ? ['f.txt'] : null);
    // Predicting does not touch the working tree, the index or refs
    expect(r.git(['status', '--porcelain']).trim()).toBe('');
    expect(r.read('f.txt').toString()).toBe('main\n');

    // Without the options, only the counts
    const plain = await m.compare.compare('other', 'main');
    expect(plain).toMatchObject({ ahead: 2, behind: 1 });
    expect(plain?.incomingFiles).toBeUndefined();
    expect(plain?.conflicts).toBeUndefined();

    expect(await m.compare.compare('main', 'no-such-branch')).toBeNull();
  });

  it('counts the commits a reset would leave only in the reflog', async () => {
    const r = repo();
    const base = r.commit('base');
    r.commit('c1');
    r.git(['branch', 'keep']);
    r.commit('c2');
    r.commit('c3');
    r.git(['tag', 't3']);
    r.commit('c4');
    const m = await model(r);
    // c1 stays on keep, c2 and c3 on the tag: only c4 is left behind
    expect(await m.compare.exclusive('main', base, 'main')).toBe(1);
    // Without leaving out the moved branch itself, it still has every commit
    expect(await m.compare.exclusive('main', base, undefined)).toBe(0);
    expect(await m.compare.exclusive('main', 'main', 'main')).toBe(0);
    expect(await m.compare.exclusive('main', 'no-such', 'main')).toBeNull();
  });

  it('counts ahead / behind of many refs against one base', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': '1\n' });
    r.git(['branch', 'merged']);
    r.git(['checkout', '-q', '-b', 'a']);
    r.commit('a 1');
    r.commit('a 2');
    // A ref under a requested name that does not exist itself: for-each-ref would match it as a pattern
    r.git(['branch', 'missing/sub']);
    r.git(['checkout', '-q', 'main']);
    r.commit('main 1');
    const m = await model(r);
    const refs = ['refs/heads/merged', 'refs/heads/a', 'refs/heads/missing'];
    const expected = { 'refs/heads/merged': { ahead: 0, behind: 1 }, 'refs/heads/a': { ahead: 2, behind: 1 } };
    expect(await m.compare.aheadBehind('main', refs)).toEqual(expected);
    // Without for-each-ref %(ahead-behind) (git older than 2.41): one rev-list per ref, same result
    const features = m.features as { aheadBehind: boolean };
    const had = features.aheadBehind;
    features.aheadBehind = false;
    try {
      expect(await m.compare.aheadBehind('main', refs)).toEqual(expected);
    } finally {
      features.aheadBehind = had;
    }
    expect(await m.compare.aheadBehind('no-such-branch', refs)).toBeNull();
  });

  it('predicts no conflicts for changes in different files', async () => {
    const r = repo();
    r.commit('base', { 'f.txt': 'base\n' });
    r.git(['checkout', '-q', '-b', 'other']);
    r.commit('other', { 'o.txt': 'o\n' });
    r.git(['checkout', '-q', 'main']);
    r.commit('main', { 'm.txt': 'm\n' });
    const m = await model(r);
    const cmp = await m.compare.compare('main', 'other', { conflicts: true });
    expect(cmp?.conflicts).toEqual(m.features.mergeTree ? [] : null);
  });
});

describe('CommitService', () => {
  it('commits with a message from stdin and returns info', async () => {
    const r = repo();
    r.write('f.txt', 'x\n');
    r.git(['add', 'f.txt']);
    const m = await model(r);
    const res = await m.commit.create({ message: '日本語のメッセージ\n\n本文 "quote" $HOME', amend: false, signoff: true, noVerify: false, pushAfter: false });
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.git(['log', '-1', '--format=%B']).trim()).toBe('日本語のメッセージ\n\n本文 "quote" $HOME\n\nSigned-off-by: Test User <test@example.com>');
    m.snapshot.invalidate();
    const info = await m.commit.info();
    expect(info.author).toEqual({ name: 'Test User', email: 'test@example.com' });
    expect(info.lastMessage).toContain('日本語のメッセージ');
    expect(info.recentMessages).toHaveLength(1);
  });

  it('tells where the current branch is pushed, and pushes exactly there', async () => {
    const r = repo();
    r.commit('one');
    const m = await model(r);
    await expect(m.commit.pushTarget()).rejects.toMatchObject({ category: 'noUpstream' });

    // Without an upstream: the same name on origin, even when another remote comes first
    const up = makeRepo({ bare: true });
    repos.push(up);
    r.git(['remote', 'add', 'aaa', 'https://example.com/other.git']);
    r.git(['remote', 'add', 'origin', up.dir]);
    const target = await m.commit.pushTarget();
    expect(target).toEqual({ branch: 'main', remote: 'origin', remoteBranch: 'main', setUpstream: true });
    await m.commit.pushCurrent(target);
    expect(r.git(['rev-parse', '--abbrev-ref', 'main@{upstream}']).trim()).toBe('origin/main');

    // With an upstream: its remote and branch, which may have another name
    r.git(['push', '-q', 'origin', 'main:release']);
    r.git(['branch', '-q', '--set-upstream-to=origin/release']);
    expect(await m.commit.pushTarget()).toEqual({ branch: 'main', remote: 'origin', remoteBranch: 'release', setUpstream: false });

    r.git(['checkout', '-q', '--detach']);
    await expect(m.commit.pushTarget()).rejects.toMatchObject({ category: 'invalid' });
  });
});

describe.skipIf(!distReady)('askpass and editor helpers', () => {
  it('answers git credential prompts through GIT_ASKPASS and the IPC pipe', async () => {
    const r = repo();
    r.commit('one');
    const m = await model(r);
    const prompts: string[] = [];
    const helpers = new GitHelpers(path.resolve(__dirname, '../..'), process.execPath);
    const auth = await helpers.authEnv(async (prompt) => {
      prompts.push(prompt);
      return /Username/.test(prompt) ? 'alice' : 's3cret';
    });
    try {
      const res = await m.runner.run(['credential', 'fill'], { stdin: 'protocol=https\nhost=example.com\n\n', env: auth.env });
      const out = res.stdout.toString();
      expect(out).toContain('username=alice');
      expect(out).toContain('password=s3cret');
      expect(prompts[0]).toMatch(/Username for 'https:\/\/example.com'/);
    } finally {
      auth.dispose();
      helpers.dispose();
    }
  });

  it('runs an interactive rebase with reorder, reword, squash and drop', async () => {
    const r = repo();
    const base = r.commit('base', { 'base.txt': 'b\n' });
    const a = r.commit('A', { 'a.txt': 'a\n' });
    const b = r.commit('B', { 'b.txt': 'b\n' });
    const c = r.commit('C', { 'c.txt': 'c\n' });
    const d = r.commit('D', { 'd.txt': 'd\n' });
    const env = testEnv({ editMessage: async (_repo, _title, initial) => `squashed: ${initial.split('\n')[0]}` });
    const m = await model(r, env);
    const list = await m.rebase.commits(base);
    expect(list.map((x) => x.subject)).toEqual(['A', 'B', 'C', 'D']);
    await m.ops.run({
      kind: 'rebase/interactive',
      base,
      todo: [
        { action: 'pick', sha: c, subject: 'C' },
        { action: 'reword', sha: a, subject: 'A', message: 'A（書き換え）' },
        { action: 'squash', sha: b, subject: 'B' },
        { action: 'drop', sha: d, subject: 'D' },
      ],
    });
    expect(m.snapshot.readSequence()).toBeNull();
    const log = r.git(['log', '--format=%s', `${base}..HEAD`]).trim().split('\n');
    expect(log).toEqual(['squashed: A（書き換え）', 'C']);
    expect(r.git(['ls-files']).trim().split('\n').sort()).toEqual(['a.txt', 'b.txt', 'base.txt', 'c.txt']);
  });

  it('stops at edit and continues', async () => {
    const r = repo();
    const base = r.commit('base');
    const a = r.commit('A', { 'a.txt': 'a\n' });
    const b = r.commit('B', { 'b.txt': 'b\n' });
    const m = await model(r);
    const res = await m.ops.run({
      kind: 'rebase/interactive',
      base,
      todo: [
        { action: 'edit', sha: a, subject: 'A' },
        { action: 'pick', sha: b, subject: 'B' },
      ],
    });
    expect(res.stopped).toBe(true);
    expect(m.snapshot.readSequence()).toMatchObject({ kind: 'rebase', interactive: true, stoppedForEdit: true, step: 1, total: 2 });
    r.write('a.txt', 'edited\n');
    await m.stage.stagePaths(['a.txt']);
    await m.ops.run({ kind: 'sequence/control', action: 'continue' });
    expect(m.snapshot.readSequence()).toBeNull();
    expect(r.git(['show', 'HEAD~1:a.txt'])).toBe('edited\n');
  });
});
