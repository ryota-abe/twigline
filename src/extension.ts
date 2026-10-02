import { chmod } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { VscodeEnv } from './host/vscodeEnv';
import { REV_SCHEME, RevisionContentProvider } from './host/RevisionContentProvider';
import { GitHelpers } from './ipc/helpers';
import { RepoPanelManager } from './panel/RepoPanelManager';
import { RepositoryManager } from './repo/RepositoryManager';
import { RepositoriesView } from './views/RepositoriesView';
import { StatusBar } from './views/StatusBar';

// activate: only creates and registers the managers. Does not call git until a panel is opened.

export interface TwiglineApi {
  repos: RepositoryManager;
  panels: RepoPanelManager;
}

export async function activate(context: vscode.ExtensionContext): Promise<TwiglineApi> {
  const env = new VscodeEnv(context);
  const helpers = new GitHelpers(context.extensionPath, env.helperExecPath);
  const repos = new RepositoryManager(env, helpers);
  const panels = new RepoPanelManager(context, repos, env);
  env.repos = repos;
  env.panels = panels;

  context.subscriptions.push(env, { dispose: () => helpers.dispose() }, repos, panels);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, new RevisionContentProvider(repos, env)));

  const tree = new RepositoriesView(repos);
  context.subscriptions.push(tree, vscode.window.createTreeView('twigline.repositories', { treeDataProvider: tree, showCollapseAll: false }));
  registerCommands(context, { repos, panels, env });

  // askpass.sh is started directly by git, so it needs the executable bit (which unpacking a VSIX may lose)
  if (process.platform !== 'win32') void chmod(path.join(context.extensionPath, 'dist', 'askpass.sh'), 0o755).catch(() => undefined);

  // Do not wait for vscode.git discovery. The status bar appears after discovery
  void repos.initialize().then(() => context.subscriptions.push(new StatusBar(repos)));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('twigline.gitPath')) repos.resetGit();
    }),
  );
  return { repos, panels };
}

export function deactivate(): void {
  // Cleaned up through context.subscriptions
}
