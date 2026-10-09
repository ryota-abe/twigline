import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SequenceState } from '../../shared/protocol';
import { countBadge, repoStatus, type RepoStatus } from '../repo/repoStatus';
import type { RepositoryManager } from '../repo/RepositoryManager';

// The native TreeView is used only for the repository list in the Activity Bar.
// Each row also shows what needs attention (an operation stopped halfway, conflicts, the number of changed files)
// without running git: from the state of vscode.git and the files in the git directory.

const t = vscode.l10n.t;

/** Rows carry a resourceUri of this scheme so the badges and colors of RepositoriesView apply only here (a file: URI would decorate the Explorer too) */
const DECORATION_SCHEME = 'twigline-repo';

/** rootUri lets the commands of the row's menus find the repository (see rootFromArg) */
type Node = { kind: 'repo'; root: string; rootUri: vscode.Uri; name: string; submodules: string[] } | { kind: 'submodule'; root: string; rootUri: vscode.Uri };

export class RepositoriesView implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationEmitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private readonly subs: vscode.Disposable[];
  /** Read once per change of vscode.git, shared by the rows and their decorations */
  private readonly statuses = new Map<string, RepoStatus>();

  constructor(private readonly repos: RepositoryManager) {
    this.subs = [
      repos.onDidChange(() => {
        this.statuses.clear();
        this.emitter.fire();
        this.decorationEmitter.fire(undefined);
      }),
      vscode.window.registerFileDecorationProvider(this),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const entry = this.repos.repositories.find((r) => r.root === node.root);
    const status = this.status(node.root);
    const item =
      node.kind === 'repo'
        ? new vscode.TreeItem(node.name, node.submodules.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        : new vscode.TreeItem(path.basename(node.root), vscode.TreeItemCollapsibleState.None);

    let head = '';
    if (node.kind === 'repo') {
      const h = entry ? this.repos.headOf(entry) : undefined;
      // HEAD is detached during a rebase: show the branch being rebased instead of the commit
      const name = (status.sequence?.kind === 'rebase' && status.sequence.branch) || h?.branch || h?.commit?.slice(0, 7);
      head = [name, h?.ahead ? `↑${h.ahead}` : '', h?.behind ? `↓${h.behind}` : ''].filter(Boolean).join(' ');
      item.description = head;
    } else {
      item.description = vscode.workspace.asRelativePath(node.root);
    }
    const stopped = status.sequence ? sequenceLabel(status.sequence) : undefined;
    if (stopped) item.description = [item.description, stopped].filter(Boolean).join(' · ');

    item.resourceUri = decorationUri(node.root);
    item.iconPath = status.conflicts
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'))
      : status.sequence
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        : new vscode.ThemeIcon(node.kind === 'repo' ? 'repo' : 'file-submodule');
    item.tooltip = tooltip(node.root, head, stopped, status);
    item.contextValue = 'twigline.repository';
    item.command = { command: 'twigline.open', title: t('Open in Twigline'), arguments: [vscode.Uri.file(node.root)] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const all = this.repos.repositories;
      const submoduleRoots = new Set(all.flatMap((r) => r.submodules.map((s) => s.toLowerCase())));
      return all
        .filter((r) => !submoduleRoots.has(r.root.toLowerCase()))
        .map((r) => ({ kind: 'repo', root: r.root, rootUri: vscode.Uri.file(r.root), name: r.name, submodules: r.submodules }));
    }
    if (node.kind === 'repo') return node.submodules.map((s) => ({ kind: 'submodule', root: s, rootUri: vscode.Uri.file(s) }));
    return [];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) return undefined;
    const key = uri.toString();
    const entry = this.repos.repositories.find((r) => decorationUri(r.root).toString() === key);
    if (!entry) return undefined;
    const s = this.status(entry.root);
    if (s.conflicts) {
      return new vscode.FileDecoration('!', t('{0} conflicted files', s.conflicts), new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
    }
    const badge = countBadge(s.changed);
    const color = s.sequence ? new vscode.ThemeColor('list.warningForeground') : undefined;
    if (!badge && !color) return undefined;
    return new vscode.FileDecoration(badge, badge ? t('{0} changed files', s.changed) : undefined, color);
  }

  private status(root: string): RepoStatus {
    let s = this.statuses.get(root);
    if (!s) {
      s = repoStatus(root, this.repos.repositories.find((r) => r.root === root)?.gitRepo?.state);
      this.statuses.set(root, s);
    }
    return s;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
    this.decorationEmitter.dispose();
  }
}

function decorationUri(root: string): vscode.Uri {
  return vscode.Uri.file(root).with({ scheme: DECORATION_SCHEME });
}

function sequenceLabel(seq: SequenceState): string {
  switch (seq.kind) {
    case 'rebase':
      return seq.step && seq.total ? t('Rebasing {0}/{1}', seq.step, seq.total) : t('Rebasing');
    case 'merge':
      return t('Merging');
    case 'cherry-pick':
      return t('Cherry-picking');
    case 'revert':
      return t('Reverting');
  }
}

function tooltip(root: string, head: string, stopped: string | undefined, s: RepoStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendText(root);
  if (head) md.appendMarkdown('\n\n$(git-branch) ').appendText(head);
  if (stopped) md.appendMarkdown('\n\n$(warning) ').appendText(t('{0} (stopped; continue or abort it in Twigline)', stopped));
  const counts = [
    s.conflicts ? t('Conflicts: {0}', s.conflicts) : '',
    s.staged ? t('Staged: {0}', s.staged) : '',
    s.unstaged ? t('Unstaged: {0}', s.unstaged) : '',
    s.untracked ? t('Untracked: {0}', s.untracked) : '',
  ].filter(Boolean);
  md.appendMarkdown('\n\n').appendText(counts.length ? counts.join(' · ') : t('No uncommitted changes'));
  return md;
}
