import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepositoryManager } from '../repo/RepositoryManager';

// The native TreeView is used only for the repository list in the Activity Bar

type Node = { kind: 'repo'; root: string; name: string; submodules: string[] } | { kind: 'submodule'; root: string };

export class RepositoriesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly repos: RepositoryManager) {
    this.sub = repos.onDidChange(() => this.emitter.fire());
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'repo') {
      const entry = this.repos.repositories.find((r) => r.root === node.root);
      const head = entry ? this.repos.headOf(entry) : undefined;
      const item = new vscode.TreeItem(
        node.name,
        node.submodules.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      const parts: string[] = [];
      if (head?.branch) parts.push(head.branch);
      else if (head?.commit) parts.push(head.commit.slice(0, 7));
      if (head?.ahead) parts.push(`↑${head.ahead}`);
      if (head?.behind) parts.push(`↓${head.behind}`);
      item.description = parts.join(' ');
      item.tooltip = node.root;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.contextValue = 'twigline.repository';
      item.command = { command: 'twigline.open', title: vscode.l10n.t('Open in Twigline'), arguments: [vscode.Uri.file(node.root)] };
      return item;
    }
    const item = new vscode.TreeItem(path.basename(node.root), vscode.TreeItemCollapsibleState.None);
    item.description = vscode.workspace.asRelativePath(node.root);
    item.tooltip = node.root;
    item.iconPath = new vscode.ThemeIcon('file-submodule');
    item.contextValue = 'twigline.repository';
    item.command = { command: 'twigline.open', title: vscode.l10n.t('Open in Twigline'), arguments: [vscode.Uri.file(node.root)] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const all = this.repos.repositories;
      const submoduleRoots = new Set(all.flatMap((r) => r.submodules.map((s) => s.toLowerCase())));
      return all
        .filter((r) => !submoduleRoots.has(r.root.toLowerCase()))
        .map((r) => ({ kind: 'repo', root: r.root, name: r.name, submodules: r.submodules }));
    }
    if (node.kind === 'repo') return node.submodules.map((s) => ({ kind: 'submodule', root: s }));
    return [];
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }
}
