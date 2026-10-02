import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoId, RpcError } from '../../shared/protocol';
import { toRpcError } from '../git/errors';
import type { VscodeEnv } from '../host/vscodeEnv';
import type { RepoPanelManager } from '../panel/RepoPanelManager';
import type { RepoModel } from '../repo/RepoModel';
import { toRepoId } from '../repo/repoId';
import type { RepoEntry, RepositoryManager } from '../repo/RepositoryManager';
import { MENU_COMMANDS, PANEL_COMMANDS } from './menuCommands';

const t = vscode.l10n.t;

interface Deps {
  repos: RepositoryManager;
  panels: RepoPanelManager;
  env: VscodeEnv;
}

export function registerCommands(context: vscode.ExtensionContext, deps: Deps): void {
  const { repos, panels, env } = deps;
  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ---- Entry points ----
  reg('twigline.open', async (arg?: unknown) => {
    const root = rootFromArg(arg) ?? (await pickRepository(repos, panels))?.root;
    if (root) await openOrReport(panels, root);
  });

  reg('twigline.fileHistory', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') return;
    const entry = repos.repositoryFor(target);
    if (!entry) {
      void vscode.window.showWarningMessage(t('This file is not in a Git repository.'));
      return;
    }
    const rel = path.relative(entry.root, target.fsPath).split(path.sep).join('/');
    await openOrReport(panels, entry.root, { view: 'history', path: rel });
  });

  // ---- Actions on the panel (targets of keybindings) ----
  const forwardToActive = (command: string) => {
    const repo = panels.activeRepo;
    if (repo) panels.forward(repo, { command, context: {} });
  };
  reg('twigline.refresh', () => forwardToActive('twigline.refresh'));
  for (const id of PANEL_COMMANDS) reg(id, () => forwardToActive(id));
  reg('twigline.view.fileStatus', () => panels.activeRepo && panels.post(panels.activeRepo, { type: 'ui/showView', view: 'fileStatus' }));
  reg('twigline.view.history', () => panels.activeRepo && panels.post(panels.activeRepo, { type: 'ui/showView', view: 'history' }));
  reg('twigline.view.search', () => panels.activeRepo && panels.post(panels.activeRepo, { type: 'ui/showView', view: 'history', focusSearch: true }));
  reg('twigline.showOutput', () => env.output.show(true));
  reg('twigline.bitbucket.signOut', () => env.signOutBitbucket());
  reg('twigline.optimize', async () => {
    const entry = await pickRepository(repos, panels);
    if (!entry) return;
    const model = await repos.model(entry.root);
    await env.uiAction(model.id, { kind: 'optimize' }).catch(() => undefined);
  });

  // ---- Right-click (webview/context): passed on to the webview ----
  for (const id of MENU_COMMANDS) {
    reg(id, (ctx?: Record<string, unknown>) => {
      const repo = typeof ctx?.repo === 'string' ? (ctx.repo as RepoId) : panels.activeRepo;
      if (!repo) return;
      panels.forward(repo, { command: id, context: sanitizeContext(ctx) });
    });
  }

  // ---- Network actions started from the Command Palette (step-by-step input with QuickPick) ----
  reg('twigline.fetch', async () => {
    const model = await pickModel(repos, panels);
    if (!model) return;
    const snap = await model.snapshot.get();
    const all = { label: `$(repo-sync) ${t('All remotes')}`, remote: '*' };
    const pick = snap.remotes.length <= 1 ? all : await vscode.window.showQuickPick([all, ...snap.remotes.map((r) => ({ label: r.name, description: r.fetchUrl, remote: r.name }))], { title: t('Fetch') });
    if (!pick) return;
    await runReported(env, model, () => model.ops.run({ kind: 'fetch', remote: pick.remote, prune: false, tags: false }, { interactive: true }));
  });

  reg('twigline.pull', async () => {
    const model = await pickModel(repos, panels);
    if (!model) return;
    const snap = await model.snapshot.get();
    if (snap.remotes.length === 0) {
      void vscode.window.showWarningMessage(t('No remote is configured.'));
      return;
    }
    const upstream = snap.head.upstream;
    const upRemote = upstream ? snap.remotes.find((r) => upstream.startsWith(r.name + '/'))?.name : undefined;
    const remotePick =
      snap.remotes.length === 1
        ? { label: snap.remotes[0].name }
        : await vscode.window.showQuickPick(
            [...snap.remotes].sort((a) => (a.name === upRemote ? -1 : 0)).map((r) => ({ label: r.name, description: r.fetchUrl })),
            { title: t('Pull: choose a remote') },
          );
    if (!remotePick) return;
    const remote = remotePick.label;
    const branches = snap.refs.filter((r) => r.kind === 'remote' && r.remote === remote).map((r) => r.name.slice(remote.length + 1));
    const preferred = upstream?.startsWith(remote + '/') ? upstream.slice(remote.length + 1) : snap.head.branch ?? undefined;
    const branchPick = await vscode.window.showQuickPick(
      branches.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b))).map((b) => ({ label: b })),
      { title: t('Pull: choose a branch') },
    );
    if (!branchPick) return;
    const modes = [
      { label: t('Merge'), rebase: false, ffOnly: false },
      { label: t('Rebase'), rebase: true, ffOnly: false },
      { label: t('Fast-forward only'), rebase: false, ffOnly: true },
    ];
    const mode = await vscode.window.showQuickPick(modes, { title: t('Pull: how to integrate') });
    if (!mode) return;
    await runReported(env, model, () =>
      model.ops.run({ kind: 'pull', remote, branch: branchPick.label, rebase: mode.rebase, ffOnly: mode.ffOnly }, { interactive: true }),
    );
  });

  reg('twigline.push', async () => {
    const model = await pickModel(repos, panels);
    if (!model) return;
    await runReported(env, model, () => model.commit.pushCurrent());
  });
}

/** Extract only the keys Twigline uses from data-vscode-context */
function sanitizeContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!ctx) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k === 'webview' || k === 'preventDefaultContextMenuItems' || k === 'webviewSection') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  out.section = ctx.webviewSection;
  return out;
}

function rootFromArg(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri) return arg.fsPath;
  if (arg && typeof arg === 'object' && 'rootUri' in arg && (arg as { rootUri?: unknown }).rootUri instanceof vscode.Uri) {
    return ((arg as { rootUri: vscode.Uri }).rootUri as vscode.Uri).fsPath;
  }
  if (typeof arg === 'string') return arg;
  return undefined;
}

async function pickRepository(repos: RepositoryManager, panels: RepoPanelManager): Promise<RepoEntry | undefined> {
  const active = panels.activeRepo;
  const list = repos.repositories;
  if (active) {
    const e = list.find((r) => r.id === active);
    if (e) return e;
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (list.length === 0) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return { id: toRepoId(folder.uri.fsPath), root: folder.uri.fsPath, name: folder.name, submodules: [] };
    void vscode.window.showWarningMessage(t('No Git repository was found.'));
    return undefined;
  }
  if (list.length === 1) return list[0];
  const current = doc?.uri.scheme === 'file' ? repos.repositoryFor(doc.uri) : undefined;
  const pick = await vscode.window.showQuickPick(
    list.map((r) => ({ label: r.name, description: vscode.workspace.asRelativePath(r.root), entry: r })).sort((a) => (a.entry.id === current?.id ? -1 : 0)),
    { title: t('Choose a repository') },
  );
  return pick?.entry;
}

async function pickModel(repos: RepositoryManager, panels: RepoPanelManager): Promise<RepoModel | undefined> {
  const entry = await pickRepository(repos, panels);
  if (!entry) return undefined;
  try {
    return await repos.model(entry.root);
  } catch (e) {
    void vscode.window.showErrorMessage(toRpcError(e).message);
    return undefined;
  }
}

async function openOrReport(panels: RepoPanelManager, root: string, opts?: { view?: 'history'; path?: string }): Promise<void> {
  try {
    await panels.open(root, opts);
  } catch (e) {
    void vscode.window.showErrorMessage(t('Twigline could not open {0}: {1}', root, toRpcError(e).message));
  }
}

/** Notify the failure of an action run on the host (shows the suggested next step as a button) */
async function runReported(env: VscodeEnv, model: RepoModel, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err: RpcError = toRpcError(e);
    if (err.category === 'cancelled') return;
    const show = t('Show Output');
    const open = t('Open in Twigline');
    const choice = await vscode.window.showErrorMessage(err.message, show, open);
    if (choice === show) env.output.show(true);
    if (choice === open) await env.panels.open(model.root, { view: err.category === 'conflict' ? 'fileStatus' : undefined });
  }
}
