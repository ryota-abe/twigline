import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MENU_COMMANDS, PALETTE_COMMANDS, PANEL_COMMANDS } from '../../src/commands/menuCommands';
import type { TwiglineApi } from '../../src/extension';

// Integration tests: run the extension in a VS Code that has opened the fixture repository, and check the git state.

const EXTENSION_ID = 'ryota-abe.twigline';

function fixtureRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace must be the fixture repository');
  return folder.uri.fsPath;
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: fixtureRoot() }).toString().trim();
}

async function api(): Promise<TwiglineApi> {
  const ext = vscode.extensions.getExtension<TwiglineApi>(EXTENSION_ID);
  assert.ok(ext, 'extension is installed');
  return ext.isActive ? ext.exports : ext.activate();
}

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('Twigline extension', function () {
  this.timeout(60_000);

  it('activates and registers every command', async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [...MENU_COMMANDS, ...PANEL_COMMANDS, ...PALETTE_COMMANDS]) assert.ok(commands.includes(id), `${id} is registered`);
  });

  it('detects the fixture repository through vscode.git', async () => {
    const a = await api();
    const entry = await until(() => a.repos.repositories.find((r) => path.resolve(r.root).toLowerCase() === path.resolve(fixtureRoot()).toLowerCase()));
    assert.strictEqual(entry.name, path.basename(fixtureRoot()));
  });

  it('opens one panel per repository and reuses it', async () => {
    const a = await api();
    await vscode.commands.executeCommand('twigline.open', vscode.Uri.file(fixtureRoot()));
    const id = a.panels.repoForRoot(fixtureRoot());
    await until(() => a.panels.has(id));
    const twiglineTabs = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => ((t.input as { viewType?: string } | undefined)?.viewType ?? '').includes('twigline.repository'));
    // The tab list is updated asynchronously, so wait for it to appear
    await until(() => twiglineTabs().length > 0 || undefined);
    await vscode.commands.executeCommand('twigline.open', vscode.Uri.file(fixtureRoot()));
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(twiglineTabs().length, 1);
  });

  it('loads the webview under the CSP and completes the startup sequence (figure 5-1)', async () => {
    const a = await api();
    const id = a.panels.repoForRoot(fixtureRoot());
    // When the webview script loads, requests arrive in the order app/init -> repo/snapshot, status/get -> log/page
    const stats = await until(() => {
      const s = a.panels.rpcStats(id);
      return s['log/page']?.ok ? s : undefined;
    }, 30_000);
    assert.ok(stats['app/init']?.ok, 'app/init');
    assert.ok(stats['repo/snapshot']?.ok, 'repo/snapshot');
    assert.ok(stats['status/get']?.ok, 'status/get');
    const failed = Object.entries(stats).filter(([, v]) => v.failed > 0);
    assert.deepStrictEqual(failed, [], 'no request failed');
  });

  it('starts the syntax highlighting worker under the CSP and resolves the grammar and theme', async () => {
    const a = await api();
    const id = a.panels.repoForRoot(fixtureRoot());
    // Selecting a commit shows the diff of the first file. syntax/* requests arrive after the Worker answers the ping
    a.panels.forward(id, { command: 'twigline.stash.showDiff', context: { sha: git(['rev-parse', 'HEAD']) } });
    const stats = await until(() => {
      const s = a.panels.rpcStats(id);
      return s['syntax/language']?.ok && s['syntax/theme']?.ok ? s : undefined;
    }, 30_000);
    assert.strictEqual(stats['syntax/language']?.failed ?? 0, 0);
    assert.strictEqual(stats['syntax/theme']?.failed ?? 0, 0);
  });

  it('reflects external changes to the index in the panel (figure 5-2)', async () => {
    const a = await api();
    const id = a.panels.repoForRoot(fixtureRoot());
    const before = a.panels.rpcStats(id)['status/get']?.ok ?? 0;
    // Same as running git add in an external terminal
    git(['add', '--', 'docs/design.md']);
    try {
      // RepoWatcher picks up the index change, and the webview that received repo/changed sends status/get again
      await until(() => (a.panels.rpcStats(id)['status/get']?.ok ?? 0) > before, 15_000);
    } finally {
      git(['reset', '-q', '--', 'docs/design.md']);
    }
  });

  it('runs operations through the repository model', async () => {
    const a = await api();
    const model = await a.repos.model(fixtureRoot());
    const snap = await model.snapshot.get();
    assert.ok(snap.head.branch, 'HEAD is on a branch');
    await model.ops.run({ kind: 'branch/create', name: 'integration/test', start: 'HEAD', checkout: false });
    assert.strictEqual(git(['rev-parse', 'integration/test']), git(['rev-parse', 'HEAD']));
    model.snapshot.invalidate();
    const after = await model.snapshot.get();
    assert.ok(after.refs.some((r) => r.name === 'integration/test'));
    await model.ops.run({ kind: 'branch/delete', names: ['integration/test'], force: false });
  });

  it('pages the history and stages a line', async () => {
    const a = await api();
    const model = await a.repos.model(fixtureRoot());
    const page = await model.log.page({ branches: 'all', includeRemotes: true, includeStashes: false, order: 'date' }, undefined, 0, 5);
    assert.strictEqual(page.rows.length, 5);
    const status = await model.status.get();
    const file = status.unstaged.find((f) => f.status === 'M');
    assert.ok(file, 'the fixture has an unstaged modification');
    const diff = await model.diff.get({ target: { kind: 'worktree' }, path: file.path, context: 3, ignoreWhitespace: false });
    const line = diff.hunks[0].lines.find((l) => l.kind === '+');
    assert.ok(line);
    await model.stage.applyLines(diff.diffId, [line.id], 'stage');
    assert.ok(git(['diff', '--cached', '--', file.path]).includes(line.text));
    await model.stage.unstagePaths([file.path]);
  });

  it('opens a revision document through the twigline-rev scheme', async () => {
    const uri = vscode.Uri.from({ scheme: 'twigline-rev', path: '/README.md', query: JSON.stringify({ root: fixtureRoot(), rev: 'HEAD' }) });
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.ok(doc.getText().includes('twigline-app'));
  });
});
