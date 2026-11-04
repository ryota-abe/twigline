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
    const root = rootFromArg(arg);
    // Another extension can pass any folder: one outside the workspace goes through the same confirmation as "Open Repository from Folder…"
    if (root) return repos.needsTrust(root) ? openFromFolder(repos, panels, root) : openOrReport(repos, panels, root);
    // From the Command Palette, always let the user choose: an open panel must not hide the other repositories
    const pick = await pickRepository(repos, panels, { preferActive: false, browse: true });
    if (pick === BROWSE) await vscode.commands.executeCommand('twigline.openFromFolder');
    else if (pick) await openOrReport(repos, panels, pick.root);
  });

  reg('twigline.openFromFolder', async () => {
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
    await openFromFolder(repos, panels, folder.fsPath);
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
    await openOrReport(repos, panels, entry.root, { view: 'history', path: rel });
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

/** The "Open Repository from Folder…" item of pickRepository */
const BROWSE = Symbol('browse');

type RepoPickItem = vscode.QuickPickItem & { entry?: RepoEntry; browse?: boolean };

/**
 * Choose the target repository. With `preferActive` (the default), the repository of the frontmost Twigline panel
 * is used without asking; otherwise a QuickPick is shown whenever there is more than one repository.
 * The other repositories (outside the workspace) are listed after a separator. With `browse`, the list also offers
 * "Open Repository from Folder…" (and it is chosen without asking when there is no repository at all).
 */
async function pickRepository(repos: RepositoryManager, panels: RepoPanelManager, opts: { preferActive: false; browse: true }): Promise<RepoEntry | typeof BROWSE | undefined>;
async function pickRepository(repos: RepositoryManager, panels: RepoPanelManager, opts?: { preferActive?: boolean }): Promise<RepoEntry | undefined>;
async function pickRepository(
  repos: RepositoryManager,
  panels: RepoPanelManager,
  opts: { preferActive?: boolean; browse?: boolean } = {},
): Promise<RepoEntry | typeof BROWSE | undefined> {
  const active = panels.activeRepo;
  const list = repos.repositories;
  const others = repos.otherRepositories;
  if (active && opts.preferActive !== false) {
    const e = list.find((r) => r.id === active) ?? others.find((r) => r.id === active);
    if (e) return e;
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (list.length === 0 && others.length === 0) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) return { id: toRepoId(folder.uri.fsPath), root: folder.uri.fsPath, name: folder.name, submodules: [] };
    if (opts.browse) return BROWSE;
    void vscode.window.showWarningMessage(t('No Git repository was found.'));
    return undefined;
  }
  if (list.length + others.length === 1 && (!opts.browse || others.length === 0)) return list[0] ?? others[0];
  // Put the repository of the active panel, then the one of the active editor, at the top
  const current = active ?? (doc?.uri.scheme === 'file' ? repos.repositoryFor(doc.uri)?.id : undefined);
  const toItem = (r: RepoEntry): RepoPickItem => ({ label: r.name, description: vscode.workspace.asRelativePath(r.root), entry: r });
  const items = list.map(toItem);
  const otherItems = others.map(toItem);
  const separator = (label: string): RepoPickItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const pick = await vscode.window.showQuickPick<RepoPickItem>(
    [
      ...items.filter((i) => i.entry?.id === current),
      ...items.filter((i) => i.entry?.id !== current),
      ...(otherItems.length > 0 ? [separator(t('Other Repositories')), ...otherItems] : []),
      ...(opts.browse ? [separator(''), { label: `$(folder-opened) ${t('Open Repository from Folder…')}`, browse: true }] : []),
    ],
    { title: t('Choose a repository') },
  );
  if (pick?.browse) return BROWSE;
  return pick?.entry;
}

/** The repository passed by a menu (a row of the repository list), otherwise the one pickRepository chooses */
async function pickModel(repos: RepositoryManager, panels: RepoPanelManager, arg?: unknown): Promise<RepoModel | undefined> {
  const root = rootFromArg(arg) ?? (await pickRepository(repos, panels))?.root;
  if (!root || !(await ensureAvailable(repos, root))) return undefined;
  // A folder passed by another extension that the user has not opened: ask first (it is not added to the list)
  if (repos.needsTrust(root) && !repos.existingModel(toRepoId(root)) && !(await confirmTrust(root))) return undefined;
  try {
    return await repos.model(root);
  } catch (e) {
    void vscode.window.showErrorMessage(toRpcError(e).message);
    return undefined;
  }
}

/**
 * "Open Repository from Folder…": a folder outside the workspace (that vscode.git has not opened and is not in the list yet)
 * is opened only after the user confirms, because Workspace Trust does not cover it; it is then added to the other repositories.
 */
async function openFromFolder(repos: RepositoryManager, panels: RepoPanelManager, folder: string): Promise<void> {
  let confirmed = false;
  if (repos.needsTrust(folder)) {
    if (!(await confirmTrust(folder))) return;
    confirmed = true;
  }
  let model: RepoModel;
  try {
    model = await repos.model(folder);
  } catch (e) {
    void vscode.window.showErrorMessage(t('Twigline could not open {0}: {1}', folder, toRpcError(e).message));
    return;
  }
  // The root can be outside the workspace even when the chosen folder is not (a repository that contains a workspace folder)
  if (repos.needsTrust(model.root)) {
    if (!confirmed && !(await confirmTrust(model.root))) {
      if (!panels.has(model.id)) repos.release(model.id);
      return;
    }
    repos.addOther(model.root);
  }
  await openOrReport(repos, panels, model.root);
}

async function confirmTrust(root: string): Promise<boolean> {
  const open = t('Open');
  const choice = await vscode.window.showWarningMessage(
    t('Open {0} in Twigline?', root),
    {
      modal: true,
      detail: t(
        "This folder is outside the workspace, so Workspace Trust does not cover it. Twigline runs git in it, and git can run programs named in the repository's settings (hooks, core.fsmonitor in .git/config and others). Open it only if you trust the repository.",
      ),
    },
    open,
  );
  return choice === open;
}

/** An other repository whose folder is gone (moved, deleted, a disconnected drive) is not opened; offer to remove it from the list */
async function ensureAvailable(repos: RepositoryManager, root: string): Promise<boolean> {
  if (!repos.isOther(root) || repos.exists(root)) return true;
  const remove = t('Remove from List');
  const choice = await vscode.window.showWarningMessage(t('{0} was not found. It may have been moved or deleted.', root), remove);
  if (choice === remove) repos.removeOther(root);
  return false;
}

async function openOrReport(repos: RepositoryManager, panels: RepoPanelManager, root: string, opts?: { view?: 'history'; path?: string }): Promise<void> {
  if (!(await ensureAvailable(repos, root))) return;
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
