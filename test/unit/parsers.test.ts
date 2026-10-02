import { afterEach, describe, expect, it } from 'vitest';
import { LOG_FORMAT, NulRecordSplitter, parseLog, parseLogRecord } from '../../src/git/parsers/log';
import { parseStatusV2 } from '../../src/git/parsers/status';
import { FOR_EACH_REF_FORMAT, STASH_FORMAT, parseConfigZ, parseForEachRef, parseStashList, remotesFromConfig } from '../../src/git/parsers/refs';
import { parseRawNumstat } from '../../src/git/parsers/diffTree';
import { parseRawDiff } from '../../src/git/parsers/diff';
import { makeRepo, type TempRepo } from './helpers';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe('log', () => {
  it('parses -z records with Japanese text and merge parents', () => {
    repo = makeRepo();
    const a = repo.commit('最初のコミット', { 'a.txt': 'a\n' });
    repo.git(['checkout', '-q', '-b', 'feature']);
    const b = repo.commit('機能を追加', { 'b.txt': 'b\n' });
    repo.git(['checkout', '-q', 'main']);
    repo.commit('main 側の変更', { 'c.txt': 'c\n' });
    repo.git(['merge', '-q', '--no-ff', '-m', "Merge branch 'feature'", 'feature']);
    const out = repo.gitBuf(['log', '-z', '--date-order', '--encoding=UTF-8', `--format=${LOG_FORMAT}`, '--branches']);
    const rows = parseLog(out);
    expect(rows).toHaveLength(4);
    expect(rows[0].subject).toBe("Merge branch 'feature'");
    expect(rows[0].parents).toHaveLength(2);
    expect(rows[0].parents[1]).toBe(b);
    expect(rows.at(-1)!.sha).toBe(a);
    expect(rows.at(-1)!.parents).toEqual([]);
    expect(rows.find((r) => r.sha === b)!.subject).toBe('機能を追加');
    expect(rows[0].author).toBe('Test User');
    expect(rows[0].authorTime).toBeGreaterThan(1_600_000_000);
  });

  it('splits records across arbitrary chunk boundaries', () => {
    const records = ['a'.repeat(40) + '\x1f\x1fX\x1fx@y\x1f1\x1fone', 'b'.repeat(40) + '\x1f' + 'a'.repeat(40) + '\x1fY\x1fy@z\x1f2\x1f二つ目'];
    const buf = Buffer.from(records.join('\0') + '\0', 'utf8');
    for (let size = 1; size < 20; size++) {
      const splitter = new NulRecordSplitter();
      const got: string[] = [];
      for (let i = 0; i < buf.length; i += size) splitter.push(buf.subarray(i, i + size), (r) => got.push(parseLogRecord(r)!.subject));
      splitter.flush((r) => got.push(String(parseLogRecord(r)?.subject)));
      expect(got).toEqual(['one', '二つ目']);
    }
  });
});

describe('status v2', () => {
  it('classifies staged, unstaged, untracked and paths with spaces and Japanese', () => {
    repo = makeRepo();
    repo.commit('init', { 'keep.txt': '1\n', 'mod both.txt': '1\n', 'del.txt': 'x\n' });
    repo.write('mod both.txt', '2\n');
    repo.git(['add', 'mod both.txt']);
    repo.write('mod both.txt', '3\n');
    repo.write('日本語 ファイル.txt', 'new\n');
    repo.git(['rm', '-q', 'del.txt']);
    repo.write('sub/dir/new.txt', 'n\n');
    const s = parseStatusV2(repo.gitBuf(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--no-renames']));
    expect(s.branch.head).toBe('main');
    expect(s.branch.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(s.staged).toEqual([
      { path: 'del.txt', status: 'D' },
      { path: 'mod both.txt', status: 'M' },
    ]);
    expect(s.unstaged).toEqual([
      { path: 'mod both.txt', status: 'M' },
      { path: 'sub/dir/new.txt', status: '?' },
      { path: '日本語 ファイル.txt', status: '?' },
    ]);
    expect(s.conflicted).toEqual([]);
  });

  it('reports unborn branches and conflicts', () => {
    repo = makeRepo();
    let s = parseStatusV2(repo.gitBuf(['status', '--porcelain=v2', '--branch', '-z']));
    expect(s.branch.oid).toBeNull();
    expect(s.branch.head).toBe('main');

    repo.commit('base', { 'f.txt': 'base\n' });
    repo.git(['checkout', '-q', '-b', 'other']);
    repo.commit('other', { 'f.txt': 'other\n' });
    repo.git(['checkout', '-q', 'main']);
    repo.commit('main', { 'f.txt': 'main\n' });
    try {
      repo.git(['merge', 'other']);
    } catch {
      /* Fails because of a conflict */
    }
    s = parseStatusV2(repo.gitBuf(['status', '--porcelain=v2', '--branch', '-z']));
    expect(s.conflicted).toEqual([{ path: 'f.txt', status: 'U', conflict: 'UU' }]);
  });

  it('reports detached HEAD and ahead/behind', () => {
    repo = makeRepo();
    const first = repo.commit('1');
    repo.commit('2');
    repo.git(['branch', 'up', first]);
    repo.git(['branch', '--set-upstream-to=up']);
    let s = parseStatusV2(repo.gitBuf(['status', '--porcelain=v2', '--branch', '-z']));
    expect(s.branch.upstream).toBe('up');
    expect(s.branch.ahead).toBe(1);
    expect(s.branch.behind).toBe(0);
    repo.git(['checkout', '-q', '--detach', first]);
    s = parseStatusV2(repo.gitBuf(['status', '--porcelain=v2', '--branch', '-z']));
    expect(s.branch.head).toBeNull();
  });
});

describe('refs', () => {
  it('parses branches, remote branches, tags (annotated) and tracking', () => {
    repo = makeRepo();
    const c1 = repo.commit('1');
    repo.commit('2');
    repo.git(['tag', 'light', c1]);
    repo.git(['tag', '-a', '-m', 'annotated', 'v1.0']);
    repo.git(['remote', 'add', 'origin', 'https://example.com/repo.git']);
    repo.git(['update-ref', 'refs/remotes/origin/main', c1]);
    repo.git(['update-ref', 'refs/remotes/my/remote/feature', c1]);
    repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    repo.git(['config', 'branch.main.remote', 'origin']);
    repo.git(['config', 'branch.main.merge', 'refs/heads/main']);
    repo.git(['branch', 'feature/login', c1]);
    const refs = parseForEachRef(
      repo.git(['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      ['origin', 'my/remote'],
    );
    const main = refs.find((r) => r.name === 'main')!;
    expect(main).toMatchObject({ kind: 'head', upstream: 'origin/main', ahead: 1, behind: 0, isHead: true });
    expect(refs.find((r) => r.name === 'feature/login')).toMatchObject({ kind: 'head', sha: c1 });
    expect(refs.find((r) => r.name === 'origin/main')).toMatchObject({ kind: 'remote', remote: 'origin' });
    expect(refs.find((r) => r.name === 'my/remote/feature')).toMatchObject({ kind: 'remote', remote: 'my/remote' });
    expect(refs.some((r) => r.name === 'origin/HEAD')).toBe(false);
    const v1 = refs.find((r) => r.name === 'v1.0')!;
    expect(v1.annotated).toBe(true);
    expect(v1.sha).toBe(repo.git(['rev-parse', 'HEAD']).trim());
    expect(refs.find((r) => r.name === 'light')).toMatchObject({ kind: 'tag', sha: c1, annotated: false });
  });

  it('parses config -z and remotes keeping case of remote names', () => {
    repo = makeRepo();
    repo.git(['remote', 'add', 'Upstream', 'https://example.com/a.git']);
    repo.git(['remote', 'add', 'origin', 'git@example.com:me/a.git']);
    repo.git(['config', 'remote.origin.pushurl', 'git@example.com:me/push.git']);
    const map = parseConfigZ(repo.git(['config', '-z', '--get-regexp', '^remote\\..+\\.(url|pushurl)$']));
    const remotes = remotesFromConfig(map);
    expect(remotes).toEqual([
      { name: 'origin', fetchUrl: 'git@example.com:me/a.git', pushUrl: 'git@example.com:me/push.git' },
      { name: 'Upstream', fetchUrl: 'https://example.com/a.git' },
    ]);
  });

  it('parses stash list', () => {
    repo = makeRepo();
    repo.commit('base', { 'f.txt': '1\n' });
    repo.write('f.txt', '2\n');
    repo.git(['stash', 'push', '-q', '-m', 'first 最初']);
    repo.write('f.txt', '3\n');
    repo.git(['stash', 'push', '-q']);
    const list = parseStashList(repo.git(['stash', 'list', '-z', `--format=${STASH_FORMAT}`]));
    expect(list).toHaveLength(2);
    expect(list[0].index).toBe(0);
    expect(list[1].index).toBe(1);
    expect(list[1].message).toContain('first 最初');
    expect(list[0].base).toBe(repo.git(['rev-parse', 'HEAD']).trim());
  });
});

describe('diff-tree', () => {
  it('parses raw + numstat with renames, binary and Japanese paths', () => {
    repo = makeRepo();
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    repo.commit('base', { 'old name.txt': body, 'bin.dat': Buffer.from([0, 1, 2, 3]), 'keep.txt': 'k\n' });
    repo.git(['rm', '-q', 'old name.txt']);
    repo.write('フォルダ/new name.txt', body + 'extra\n');
    repo.write('bin.dat', Buffer.from([0, 9, 9, 9, 9]));
    repo.write('added.txt', 'a\nb\n');
    repo.git(['rm', '-q', 'keep.txt']);
    repo.git(['add', '-A']);
    repo.commit('change');
    const files = parseRawNumstat(repo.gitBuf(['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-commit-id', 'HEAD~1', 'HEAD']));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['フォルダ/new name.txt']).toMatchObject({ status: 'R', oldPath: 'old name.txt', additions: 1, deletions: 0 });
    expect(byPath['bin.dat']).toMatchObject({ status: 'M', binary: true });
    expect(byPath['added.txt']).toMatchObject({ status: 'A', additions: 2, deletions: 0 });
    expect(byPath['keep.txt']).toMatchObject({ status: 'D', additions: 0, deletions: 1 });
  });

  it('handles the root commit', () => {
    repo = makeRepo();
    const sha = repo.commit('root', { 'a.txt': 'x\n' });
    const files = parseRawNumstat(repo.gitBuf(['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--root', '--no-commit-id', sha]));
    expect(files).toEqual([{ path: 'a.txt', status: 'A', additions: 1, deletions: 0 }]);
  });
});

describe('raw diff', () => {
  it('keeps CRLF bytes and no-newline markers', () => {
    repo = makeRepo();
    repo.commit('base', { 'f.txt': 'a\r\nb\r\nc' });
    repo.write('f.txt', 'a\r\nB\r\nc\r\nd');
    const raw = parseRawDiff(repo.gitBuf(['diff', '--no-color', '-U3', '--', 'f.txt']));
    expect(raw.hunks).toHaveLength(1);
    const lines = raw.hunks[0].lines;
    const kinds = lines.map((l) => l.kind + l.content.toString('latin1'));
    expect(kinds).toEqual([' a\r', '-b\r', '-c', '+B\r', '+c\r', '+d']);
    expect(lines.find((l) => l.kind === '-' && l.content.toString() === 'c')!.noEol).toBe(true);
    expect(lines.at(-1)!.noEol).toBe(true);
    expect(lines[0]).toMatchObject({ oldNo: 1, newNo: 1 });
  });

  it('detects binary, new and deleted files', () => {
    repo = makeRepo();
    repo.commit('base', { 'gone.txt': 'x\n' });
    repo.write('bin.dat', Buffer.from([0, 1, 2]));
    repo.git(['add', 'bin.dat']);
    repo.git(['rm', '-q', 'gone.txt']);
    expect(parseRawDiff(repo.gitBuf(['diff', '--cached', '--', 'bin.dat'])).binary).toBe(true);
    const del = parseRawDiff(repo.gitBuf(['diff', '--cached', '--', 'gone.txt']));
    expect(del.deletedFile).toBe(true);
    repo.write('new.txt', 'n\n');
    let out: Buffer;
    try {
      out = repo.gitBuf(['diff', '--no-index', '--', '/dev/null', 'new.txt']);
    } catch (e) {
      out = (e as { stdout: Buffer }).stdout;
    }
    const added = parseRawDiff(out);
    expect(added.newFile).toBe(true);
    expect(added.hunks[0].lines).toHaveLength(1);
  });
});
