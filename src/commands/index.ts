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
    // Another extension can pass any folder: openRepository asks first when it is outside what the user trusts
    const root = rootFromArg(arg);
    if (root) return openRepository(repos, panels, root);
    // From the Command Palette, always let the user choose: an open panel must not hide the other repositories
    const pick = await pickRepositoryToOpen(repos, panels);
    if (pick === 'browse') await openFromFolder(repos, panels);
    else if (pick) await openRepository(repos, panels, pick.root);
  });

  reg('twigline.openFromFolder', () => openFromFolder(repos, panels));

  reg('twigline.fileHistory', async (uri?: vscode.Uri) => {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') return;
    const entry = repos.repositoryFor(target);
    if (!entry) {
      void vscode.window.showWarningMessage(t('This file is not in a Git repository.'));
      return;
    }
    const rel = path.relative(entry.root, target.fsPath).split(path.sep).join('/');
    await openRepository(repos, panels, entry.root, { view: 'history', path: rel });
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
  reg('twigline.gitlab.signOut', () => env.signOutGitLab());
  reg('twigline.optimize', async () => {
    const model = await pickModel(repos, panels);
    if (!model) return;
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
  reg('twigline.fetch', async (arg?: unknown) => {
    const model = await pickModel(repos, panels, arg);
    if (!model) return;
    const snap = await model.snapshot.get();
    const all = { label: `$(repo-sync) ${t('All remotes')}`, remote: '*' };
    const pick = snap.remotes.length <= 1 ? all : await vscode.window.showQuickPick([all, ...snap.remotes.map((r) => ({ label: r.name, description: r.fetchUrl, remote: r.name }))], { title: t('Fetch') });
    if (!pick) return;
    await runReported(env, model, () => model.ops.run({ kind: 'fetch', remote: pick.remote, prune: false, tags: false }, { interactive: true }));
  });

  reg('twigline.pull', async (arg?: unknown) => {
    const model = await pickModel(repos, panels, arg);
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

  reg('twigline.push', async (arg?: unknown) => {
    const model = await pickModel(repos, panels, arg);
    if (!model) return;
    await runReported(env, model, async () => {
      const target = await model.commit.pushTarget();
      const push = t('Push');
      const choice = await vscode.window.showWarningMessage(
        t('Push {0} to {1}/{2}?', target.branch, target.remote, target.remoteBranch),
        {
          modal: true,
          detail: target.setUpstream
            ? t('{0} has no upstream. {1}/{2} will be created and set as its upstream.', target.branch, target.remote, target.remoteBranch)
            : undefined,
        },
        push,
      );
      if (choice !== push) return;
      await model.commit.pushCurrent(target);
    });
  });

  // ---- Repository list (TreeView) ----
  reg('twigline.repositories.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`));
  reg('twigline.repository.openTerminal', async (arg?: unknown) => {
    const root = rootFromArg(arg);
    if (root) await env.openTerminal(root);
  });
  reg('twigline.repository.copyPath', async (arg?: unknown) => {
    const root = rootFromArg(arg);
    if (root) await vscode.env.clipboard.writeText(root);
  });
  reg('twigline.repository.removeFromList', (arg?: unknown) => {
    const root = rootFromArg(arg);
    if (root) repos.removeOther(root);
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

// ---- Choosing a repository ----

type RepoPickItem = vscode.QuickPickItem & { entry?: RepoEntry; browse?: boolean };

/**
 * The repositories of the workspace: the ones vscode.git has opened, or the first workspace folder when it has none
 * (it may still be discovering, or be disabled)
 */
function workspaceRepositories(repos: RepositoryManager): RepoEntry[] {
  const list = repos.repositories;
  if (list.length > 0) return list;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? [{ id: toRepoId(folder.uri.fsPath), root: folder.uri.fsPath, name: folder.name, submodules: [] }] : [];
}

/** The repositories of the workspace (the current one first), then other repositories after a separator, then optionally "Open Repository from Folder…" */
async function showRepositoryPick(
  repos: RepositoryManager,
  panels: RepoPanelManager,
  main: RepoEntry[],
  others: RepoEntry[],
  browse: boolean,
): Promise<RepoEntry | 'browse' | undefined> {
  // The repository of the active panel, then the one of the active editor
  const doc = vscode.window.activeTextEditor?.document;
  const current = panels.activeRepo ?? (doc?.uri.scheme === 'file' ? repos.repositoryFor(doc.uri)?.id : undefined);
  const toItem = (r: RepoEntry): RepoPickItem => ({ label: r.name, description: vscode.workspace.asRelativePath(r.root), entry: r });
  const separator = (label: string): RepoPickItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const pick = await vscode.window.showQuickPick<RepoPickItem>(
    [
      ...main.filter((r) => r.id === current).map(toItem),
      ...main.filter((r) => r.id !== current).map(toItem),
      ...(others.length > 0 ? [separator(t('Other Repositories')), ...others.map(toItem)] : []),
      ...(browse ? [separator(''), { label: `$(folder-opened) ${t('Open Repository from Folder…')}`, browse: true }] : []),
    ],
    { title: t('Choose a repository') },
  );
  return pick?.browse ? 'browse' : pick?.entry;
}

/**
 * The target of a command such as fetch. With `preferActive` (the default), the repository of the frontmost Twigline panel;
 * otherwise the only repository of the workspace, or a QuickPick. Other repositories are offered only while their panel is open
 * (the list is shared by every window), and never chosen without asking.
 */
async function pickRepository(repos: RepositoryManager, panels: RepoPanelManager, opts: { preferActive?: boolean } = {}): Promise<RepoEntry | undefined> {
  const main = workspaceRepositories(repos);
  const active = panels.activeRepo;
  if (active && opts.preferActive !== false) {
    const e = main.find((r) => r.id === active) ?? repos.findEntry(active);
    if (e) return e;
  }
  const others = repos.otherRepositories.filter((r) => panels.has(r.id));
  if (others.length === 0 && main.length === 1) return main[0];
  if (others.length === 0 && main.length === 0) {
    void vscode.window.showWarningMessage(t('No Git repository was found.'));
    return undefined;
  }
  const pick = await showRepositoryPick(repos, panels, main, others, false);
  return pick === 'browse' ? undefined : pick;
}

/** "Open Repository in Twigline" from the Command Palette: every repository, other repositories and "Open Repository from Folder…" */
async function pickRepositoryToOpen(repos: RepositoryManager, panels: RepoPanelManager): Promise<RepoEntry | 'browse' | undefined> {
  const main = workspaceRepositories(repos);
  const others = repos.otherRepositories;
  if (others.length === 0 && main.length <= 1) return main[0] ?? 'browse';
  return showRepositoryPick(repos, panels, main, others, true);
}

/** The repository passed by a menu (a row of the repository list) or another extension, otherwise the one pickRepository chooses */
async function pickModel(repos: RepositoryManager, panels: RepoPanelManager, arg?: unknown): Promise<RepoModel | undefined> {
  const root = rootFromArg(arg) ?? (await pickRepository(repos, panels))?.root;
  return root ? trustedModel(repos, root, { list: false }) : undefined;
}

// ---- Opening a repository (and asking before running git where Workspace Trust does not reach) ----

/** "Open Repository from Folder…" */
async function openFromFolder(repos: RepositoryManager, panels: RepoPanelManager): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    title: t('Open Repository from Folder'),
    openLabel: t('Open in Twigline'),
  });
  const folder = picked?.[0];
  if (!folder) return;
  if (folder.scheme !== 'file') {
    void vscode.window.showWarningMessage(t('Only folders on the file system can be opened.'));
    return;
  }
  await openRepository(repos, panels, folder.fsPath);
}

/** Open the panel of the repository at (or containing) `root`; a repository outside what the user trusts is added to the other repositories once confirmed */
async function openRepository(repos: RepositoryManager, panels: RepoPanelManager, root: string, opts?: { view?: 'history'; path?: string }): Promise<void> {
  const model = await trustedModel(repos, root, { list: true });
  if (!model) return;
  try {
    await panels.open(model.root, opts);
  } catch (e) {
    void vscode.window.showErrorMessage(t('Twigline could not open {0}: {1}', model.root, toRpcError(e).message));
  }
}

/**
 * The RepoModel of the repository at (or containing) `folder`, asking the user first when it is outside what they trust
 * (see RepositoryManager.isTrusted). Before that only `git rev-parse` runs, to find the repository root, which is what is asked
 * about (the folder may be inside a larger repository); it runs no hooks and no file system monitor.
 * `list`: add the confirmed repository to the other repositories (a panel: that is how it is listed and found again);
 * otherwise it is trusted for this session only (a fetch another extension asked for).
 */
async function trustedModel(repos: RepositoryManager, folder: string, opts: { list: boolean }): Promise<RepoModel | undefined> {
  if (!(await ensureAvailable(repos, folder))) return undefined;
  const existed = !!repos.existingModel(toRepoId(folder));
  let model: RepoModel;
  try {
    model = await repos.model(folder);
  } catch (e) {
    void vscode.window.showErrorMessage(t('Twigline could not open {0}: {1}', folder, toRpcError(e).message));
    return undefined;
  }
  if (repos.isTrusted(model.root)) return model;
  if (!(await confirmTrust(folder, model.root))) {
    // A model that was already open may be in use by another command
    if (!existed) repos.release(model.id);
    return undefined;
  }
  if (opts.list) repos.addOther(model.root);
  else repos.trustForSession(model.root);
  return model;
}

async function confirmTrust(folder: string, root: string): Promise<boolean> {
  const open = t('Open');
  const choice = await vscode.window.showWarningMessage(
    toRepoId(folder) === toRepoId(root) ? t('Open {0} in Twigline?', root) : t('{0} is in the repository {1}. Open {1} in Twigline?', folder, root),
    {
      modal: true,
      detail: t(
        "This repository is outside the workspace, so Workspace Trust does not cover it. Twigline runs git in it, and git can run programs named in the repository's settings (hooks, core.fsmonitor in .git/config and others). Open it only if you trust the repository.",
      ),
    },
    open,
  );
  return choice === open;
}

/** An other repository whose folder cannot be used (moved, deleted, a disconnected drive) is not opened; offer to remove it from the list */
async function ensureAvailable(repos: RepositoryManager, root: string): Promise<boolean> {
  if (!repos.isOther(root) || (await repos.isAvailable(root))) return true;
  const remove = t('Remove from List');
  const choice = await vscode.window.showWarningMessage(t('{0} is not available. It may have been moved or deleted, or its drive may be disconnected.', root), remove);
  if (choice === remove) repos.removeOther(root);
  return false;
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
