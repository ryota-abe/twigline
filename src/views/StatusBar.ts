import * as vscode from 'vscode';
import type { RepoEntry, RepositoryManager } from '../repo/RepositoryManager';

/** Status bar item "main ↑1 ↓2". Clicking it opens Twigline. Uses the state of vscode.git and does not call git. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('twigline.status', vscode.StatusBarAlignment.Left, 49);
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly repos: RepositoryManager) {
    this.item.name = 'Twigline';
    this.subs.push(
      repos.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
    this.update();
  }

  private current(): RepoEntry | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc?.uri.scheme === 'file') {
      const r = this.repos.repositoryFor(doc.uri);
      if (r) return r;
    }
    return this.repos.repositories[0];
  }

  private update(): void {
    const entry = this.current();
    if (!entry) {
      this.item.hide();
      return;
    }
    const head = this.repos.headOf(entry);
    const name = head.branch ?? (head.commit ? head.commit.slice(0, 7) : '…');
    let text = `$(git-merge) ${name}`;
    if (head.ahead) text += ` ↑${head.ahead}`;
    if (head.behind) text += ` ↓${head.behind}`;
    this.item.text = text;
    this.item.tooltip = vscode.l10n.t('Open {0} in Twigline', entry.name);
    this.item.command = { command: 'twigline.open', title: 'Twigline', arguments: [vscode.Uri.file(entry.root)] };
    this.item.show();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.item.dispose();
  }
}
