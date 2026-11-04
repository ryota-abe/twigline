import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SequenceState } from '../../shared/protocol';
import { countBadge, type RepoStatus } from '../repo/repoStatus';
import { toRepoId } from '../repo/repoId';
import type { RepoEntry, RepositoryManager } from '../repo/RepositoryManager';

// The native TreeView is used only for the repository list in the Activity Bar.
// Each row also shows what needs attention (an operation stopped halfway, conflicts, the number of changed files)
// without running git: from the state of vscode.git and the files in the git directory.
// Repositories outside the workspace that the user opened in Twigline are listed under "Other Repositories" at the end;
// their state is shown while their panel is open (see RepositoryManager.statusOf).

const t = vscode.l10n.t;

/** Rows carry a resourceUri of this scheme so the badges and colors of RepositoriesView apply only here (a file: URI would decorate the Explorer too) */
const DECORATION_SCHEME = 'twigline-repo';

/** rootUri lets the commands of the row's menus find the repository (see rootFromArg) */
type Node =
  | { kind: 'repo'; root: string; rootUri: vscode.Uri; name: string; submodules: string[]; other: boolean }
  | { kind: 'submodule'; root: string; rootUri: vscode.Uri }
  | { kind: 'others' };

export class RepositoriesView implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationEmitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;
  private readonly subs: vscode.Disposable[];
  /** Read once per change of vscode.git, shared by the rows and their decorations */
  private readonly statuses = new Map<string, RepoStatus | undefined>();

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
    if (node.kind === 'others') {
      const group = new vscode.TreeItem(t('Other Repositories'), vscode.TreeItemCollapsibleState.Expanded);
      group.id = 'twigline.otherRepositories';
      group.tooltip = t('Repositories outside the workspace opened in Twigline. Every window shows them.');
      group.contextValue = 'twigline.otherRepositories';
      return group;
    }
    const entry = this.repos.findEntry(toRepoId(node.root));
    const status = this.status(node.root);
    const item =
      node.kind === 'repo'
        ? new vscode.TreeItem(node.name, node.submodules.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
        : new vscode.TreeItem(path.basename(node.root), vscode.TreeItemCollapsibleState.None);

    let head = '';
    if (node.kind === 'repo') {
      const h = entry ? this.repos.headOf(entry) : undefined;
      // HEAD is detached during a rebase: show the branch being rebased instead of the commit
      const name = (status?.sequence?.kind === 'rebase' && status.sequence.branch) || h?.branch || h?.commit?.slice(0, 7);
      head = [name, h?.ahead ? `↑${h.ahead}` : '', h?.behind ? `↓${h.behind}` : ''].filter(Boolean).join(' ');
      // An other repository that is not open shows where it is instead
      item.description = head || (node.other ? tildify(path.dirname(node.root)) : '');
    } else {
      item.description = vscode.workspace.asRelativePath(node.root);
    }
    const stopped = status?.sequence ? sequenceLabel(status.sequence) : undefined;
    if (stopped) item.description = [item.description, stopped].filter(Boolean).join(' · ');

    item.resourceUri = decorationUri(node.root);
    item.iconPath = status?.conflicts
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'))
      : status?.sequence
        ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
        : new vscode.ThemeIcon(node.kind === 'repo' ? 'repo' : 'file-submodule');
    item.tooltip = tooltip(node.root, head, stopped, status);
    item.contextValue = node.kind === 'repo' && node.other ? 'twigline.repository.other' : 'twigline.repository';
    item.command = { command: 'twigline.open', title: t('Open in Twigline'), arguments: [vscode.Uri.file(node.root)] };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const all = this.repos.repositories;
      const submoduleRoots = new Set(all.flatMap((r) => r.submodules.map((s) => s.toLowerCase())));
      const rows = all.filter((r) => !submoduleRoots.has(r.root.toLowerCase())).map((r) => repoNode(r, false));
      return this.repos.otherRepositories.length > 0 ? [...rows, { kind: 'others' }] : rows;
    }
    if (node.kind === 'others') return this.repos.otherRepositories.map((r) => repoNode(r, true));
    if (node.kind === 'repo') return node.submodules.map((s) => ({ kind: 'submodule', root: s, rootUri: vscode.Uri.file(s) }));
    return [];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== DECORATION_SCHEME) return undefined;
    const key = uri.toString();
    const entry = [...this.repos.repositories, ...this.repos.otherRepositories].find((r) => decorationUri(r.root).toString() === key);
    if (!entry) return undefined;
    const s = this.status(entry.root);
    if (!s) return undefined;
    if (s.conflicts) {
      return new vscode.FileDecoration('!', t('{0} conflicted files', s.conflicts), new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
    }
    const badge = countBadge(s.changed);
    const color = s.sequence ? new vscode.ThemeColor('list.warningForeground') : undefined;
    if (!badge && !color) return undefined;
    return new vscode.FileDecoration(badge, badge ? t('{0} changed files', s.changed) : undefined, color);
  }

  /** undefined for an other repository that is not open (its folder is not read: it may be on a disconnected drive) */
  private status(root: string): RepoStatus | undefined {
    if (!this.statuses.has(root)) {
      const entry = this.repos.findEntry(toRepoId(root));
      // A submodule vscode.git has not opened: from its git directory only
      this.statuses.set(root, entry ? this.repos.statusOf(entry) : this.repos.statusOfFolder(root));
    }
    return this.statuses.get(root);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.emitter.dispose();
    this.decorationEmitter.dispose();
  }
}

function repoNode(r: RepoEntry, other: boolean): Node {
  return { kind: 'repo', root: r.root, rootUri: vscode.Uri.file(r.root), name: r.name, submodules: r.submodules, other };
}

/** ~/src instead of /home/me/src */
function tildify(p: string): string {
  const home = os.homedir();
  if (!home) return p;
  const rel = path.relative(home, p);
  if (rel === '') return '~';
  return rel.startsWith('..') || path.isAbsolute(rel) ? p : `~${path.sep}${rel}`;
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

function tooltip(root: string, head: string, stopped: string | undefined, s: RepoStatus | undefined): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendText(root);
  if (!s) return md.appendMarkdown('\n\n').appendText(t('Its state is shown while it is open in Twigline.'));
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
