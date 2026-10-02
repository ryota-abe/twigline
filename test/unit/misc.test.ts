import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

function readdirRecursive(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? readdirRecursive(p) : [p];
  });
}
import { describe, expect, it } from 'vitest';
import * as iconv from 'iconv-lite';
import { MENU_COMMANDS, PALETTE_COMMANDS, PANEL_COMMANDS } from '../../src/commands/menuCommands';
import { chooseEncoding, guessJapanese, isValidUtf8 } from '../../src/git/encoding';
import { classifyGitError, extractOverwrittenFiles } from '../../src/git/errors';
import { GitRunner, formatCommand, maskCredentials, parseProgress } from '../../src/git/GitRunner';
import { classifyGitPath } from '../../src/repo/RepoWatcher';
import { buildTodo, stripComments } from '../../src/services/RebaseService';
import { parseRemoteUrl, pullRequestUrl } from '../../src/util/hosting';
import { makeRepo } from './helpers';

const root = path.resolve(__dirname, '../..');

describe('encoding', () => {
  it('detects UTF-8, Shift_JIS and EUC-JP', () => {
    const text = 'ログイン画面の入力チェック';
    expect(isValidUtf8(Buffer.from(text))).toBe(true);
    const sjis = iconv.encode(text, 'shift_jis');
    const euc = iconv.encode(text, 'euc-jp');
    expect(isValidUtf8(sjis)).toBe(false);
    expect(guessJapanese(sjis)).toBe('shift_jis');
    expect(guessJapanese(euc)).toBe('euc-jp');
    const ja = { encoding: 'utf8', autoGuess: true, language: 'ja' };
    expect(chooseEncoding(Buffer.from(text), ja)).toBe('utf8');
    expect(chooseEncoding(sjis, ja)).toBe('shift_jis');
    expect(chooseEncoding(euc, ja)).toBe('euc-jp');
    // If auto-guessing is off, follow files.encoding
    expect(chooseEncoding(sjis, { encoding: 'shiftjis', autoGuess: false })).toBe('shift_jis');
    expect(chooseEncoding(sjis, { encoding: 'utf8', autoGuess: false })).toBe('utf8');
  });

  it('does not treat Latin-1 text as Japanese outside a Japanese UI', () => {
    const latin = Buffer.from('caf\xe9 na\xefve r\xe9sum\xe9\n', 'latin1');
    expect(chooseEncoding(latin, { encoding: 'utf8', autoGuess: true, language: 'en' })).not.toBe('shift_jis');
  });
});

describe('error classification', () => {
  it.each([
    ['CONFLICT (content): Merge conflict in a.txt', 'conflict'],
    ['error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.', 'dirtyWorktree'],
    [' ! [rejected]        main -> main (fetch first)', 'rejected'],
    ['fatal: Authentication failed for \'https://example.com/\'', 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ["fatal: Unable to create '/r/.git/index.lock': File exists.", 'locked'],
    ['fatal: The current branch topic has no upstream branch.', 'noUpstream'],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", 'network'],
    ['fatal: something else', 'unknown'],
  ])('%s → %s', (stderr, category) => {
    expect(classifyGitError(stderr, 1, ['push'])).toBe(category);
  });

  it('extracts files that would be overwritten', () => {
    const stderr = 'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\n\tdir/日本語.txt\nPlease commit your changes or stash them before you switch branches.\nAborting';
    expect(extractOverwrittenFiles(stderr)).toEqual(['a.txt', 'dir/日本語.txt']);
  });
});

describe('GitRunner', () => {
  it('formats commands for the output channel and masks credentials', () => {
    expect(maskCredentials('https://user:token@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(formatCommand(['-c', 'core.quotepath=false', 'push', 'https://u:p@h/x', 'a b'])).toBe('git push https://***@h/x "a b"');
  });

  it('parses progress lines', () => {
    expect(parseProgress('Receiving objects:  45% (123/273), 1.20 MiB | 2 MiB/s')).toEqual({
      message: 'Receiving objects:  45% (123/273), 1.20 MiB | 2 MiB/s',
      percent: 45,
    });
    expect(parseProgress('remote: Counting objects: 100% (5/5), done.')?.percent).toBe(100);
  });

  it('serializes writes, lets reads wait for writes, and aborts', async () => {
    const repo = makeRepo();
    try {
      repo.commit('one');
      const runner = new GitRunner({ gitPath: 'git', cwd: repo.dir });
      const order: string[] = [];
      const w = runner.run(['commit', '--allow-empty', '-q', '-m', 'w'], { queue: 'write' }).then(() => order.push('write'));
      const r = runner.run(['rev-list', '--count', 'HEAD'], { queue: 'read' }).then((res) => order.push(`read:${res.stdout.toString().trim()}`));
      await Promise.all([w, r]);
      // A read that arrives while a write is running waits for the write to finish, so the new commit is visible
      expect(order).toEqual(['write', 'read:2']);

      const ctrl = new AbortController();
      const slow = runner.run(['hash-object', '--stdin'], { signal: ctrl.signal, stdin: undefined });
      ctrl.abort();
      await expect(slow).rejects.toMatchObject({ name: 'AbortError' });

      const failed = await runner.run(['rev-parse', '--verify', 'nope'], { noThrow: true });
      expect(failed.exitCode).not.toBe(0);
      await expect(runner.run(['checkout', 'no-such-branch'], { queue: 'write' })).rejects.toMatchObject({ name: 'GitError' });
    } finally {
      repo.cleanup();
    }
  });
});

describe('RepoWatcher classification', () => {
  it.each([
    ['index', ['status']],
    ['HEAD', ['head', 'status']],
    ['refs/heads/feature/x', ['refs']],
    ['packed-refs', ['refs']],
    ['refs/stash', ['stash']],
    ['logs/refs/stash', ['stash']],
    ['MERGE_HEAD', ['sequence', 'status']],
    ['rebase-merge/msgnum', ['sequence', 'status']],
    ['FETCH_HEAD', ['refs']],
    ['config', ['config']],
    ['index.lock', []],
    ['objects/ab/cdef', []],
    ['logs/HEAD', []],
  ])('%s', (p, kinds) => {
    expect(classifyGitPath(p)).toEqual(kinds);
  });
});

describe('interactive rebase todo', () => {
  it('builds the todo and validates actions', () => {
    expect(
      buildTodo([
        { action: 'pick', sha: 'abc1234', subject: 'one\ntwo' },
        { action: 'squash', sha: 'def5678', subject: 's' },
      ]),
    ).toBe('pick abc1234 one two\nsquash def5678 s\n');
    expect(() => buildTodo([{ action: 'squash', sha: 'abc1234', subject: 'x' }])).toThrow();
    expect(() => buildTodo([{ action: 'exec' as never, sha: 'abc1234', subject: 'x' }])).toThrow();
    expect(stripComments('msg\n# comment\n\nbody\n# c')).toBe('msg\n\nbody');
  });
});

describe('pull request URLs', () => {
  it.each([
    ['git@github.com:me/repo.git', 'feature/x', 'https://github.com/me/repo/compare/feature/x?expand=1'],
    ['https://github.com/me/repo', 'main', 'https://github.com/me/repo/compare/main?expand=1'],
    ['https://gitlab.com/g/sub/repo.git', 'a b', 'https://gitlab.com/g/sub/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=a%20b'],
    ['git@bitbucket.org:team/repo.git', 'dev', 'https://bitbucket.org/team/repo/pull-requests/new?source=dev'],
    ['git@ssh.dev.azure.com:v3/org/proj/repo', 'dev', 'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=dev'],
    ['https://org.visualstudio.com/proj/_git/repo', 'dev', 'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=dev'],
  ])('%s', (url, branch, expected) => {
    expect(pullRequestUrl(url, branch)).toBe(expected);
  });

  it('parses ssh URLs with ports', () => {
    expect(parseRemoteUrl('ssh://git@example.com:2222/me/repo.git')).toEqual({ host: 'example.com', path: 'me/repo' });
    expect(pullRequestUrl('https://example.com/me/repo.git', 'x')).toBeUndefined();
  });
});

describe('manifest', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
  const nlsJa = JSON.parse(readFileSync(path.join(root, 'package.nls.ja.json'), 'utf8'));

  it('declares every registered command and nothing else', () => {
    const declared = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).sort();
    expect(declared).toEqual([...MENU_COMMANDS, ...PANEL_COMMANDS, ...PALETTE_COMMANDS].sort());
  });

  it('keeps Twigline operations out of the editor title bar and shows panel operations only for Twigline panels', () => {
    // The editor title bar sits beside VS Code's own buttons, so individual Twigline actions are not put there (they go inside the panel, by the scope they work on)
    expect(pkg.contributes.menus['editor/title']).toBeUndefined();
    const palette = pkg.contributes.menus.commandPalette as { command: string; when: string }[];
    for (const id of PANEL_COMMANDS) {
      expect(['false', "activeWebviewPanelId == 'twigline.repository'"], id).toContain(palette.find((m) => m.command === id)?.when);
    }
  });

  it('hides context menu commands from the command palette', () => {
    const hidden = (pkg.contributes.menus.commandPalette as { command: string; when: string }[]).filter((m) => m.when === 'false').map((m) => m.command);
    for (const id of MENU_COMMANDS) expect(hidden).toContain(id);
  });

  it('has English and Japanese strings for every placeholder', () => {
    const text = JSON.stringify(pkg);
    const keys = [...text.matchAll(/%([\w.]+)%/g)].map((m) => m[1]);
    for (const k of keys) {
      expect(nls, k).toHaveProperty([k]);
      expect(nlsJa, k).toHaveProperty([k]);
    }
    expect(Object.keys(nlsJa).sort()).toEqual(Object.keys(nls).sort());
  });

  it('translates every vscode.l10n.t string of the host into Japanese', () => {
    const bundle = JSON.parse(readFileSync(path.join(root, 'l10n', 'bundle.l10n.ja.json'), 'utf8')) as Record<string, string>;
    const files = readdirRecursive(path.join(root, 'src')).filter((f) => f.endsWith('.ts'));
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (!/vscode\.l10n\.t|const t = vscode\.l10n\.t/.test(text)) continue;
      for (const m of text.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(10);
    for (const s of used) expect(bundle, s).toHaveProperty([s]);
  });

  it('keeps executable paths and custom actions out of workspace settings', () => {
    const props = pkg.contributes.configuration.properties;
    expect(props['twigline.gitPath'].scope).toBe('machine');
    expect(props['twigline.customActions'].scope).toBe('application');
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(false);
  });

  it('ships the English README in the VSIX and links to the Japanese one', () => {
    const ignore = readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('!README.md');
    expect(ignore).toContain('!LICENSE');
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toMatch(/^## Usage$/m);
    expect(readme).toContain('(./README.ja.md)');
    const readmeJa = readFileSync(path.join(root, 'README.ja.md'), 'utf8');
    expect(readmeJa).toMatch(/^## 使い方$/m);
    expect(readmeJa).toContain('(./README.md)');
  });
});
