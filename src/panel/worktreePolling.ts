import * as vscode from 'vscode';
import { isSameOrInside } from '../repo/otherRepositories';
import type { RepoModel } from '../repo/RepoModel';
import { StatusPoller, statusFingerprint } from '../repo/statusPoller';

/**
 * Working tree changes of a repository vscode.git does not know (an other repository, outside the workspace), without watching its folder.
 * `git status` is read again when the window gets focus or the panel becomes visible, when a file in the repository is saved,
 * created, deleted or renamed in VS Code, and every few seconds while the panel is visible and the window has focus
 * (for programs that change files meanwhile, such as a build in the terminal). The panel is told only when the result differs.
 */
export function pollWorktree(model: RepoModel, panel: vscode.WebviewPanel): vscode.Disposable {
  /** The change being notified is the poller's own (not a reason to resync) */
  let notifying = false;
  const poller = new StatusPoller({
    read: async () => {
      if (model.busy) return undefined;
      model.status.invalidate();
      return statusFingerprint(model.root, model.gitDir, await model.status.getParsed());
    },
    onChange: () => {
      notifying = true;
      model.notifyChanged(['status']);
    },
  });
  const update = () => poller.setActive(panel.visible && vscode.window.state.focused);
  const touches = (uris: readonly vscode.Uri[]) => uris.some((u) => u.scheme === 'file' && isSameOrInside(u.fsPath, model.root));
  const poke = (uris: readonly vscode.Uri[]) => touches(uris) && poller.poke();
  const subs: { dispose(): void }[] = [
    panel.onDidChangeViewState(update),
    vscode.window.onDidChangeWindowState(update),
    vscode.workspace.onDidSaveTextDocument((d) => poke([d.uri])),
    vscode.workspace.onDidCreateFiles((e) => poke(e.files)),
    vscode.workspace.onDidDeleteFiles((e) => poke(e.files)),
    vscode.workspace.onDidRenameFiles((e) => poke(e.files.flatMap((f) => [f.oldUri, f.newUri]))),
    model.onDidChange((kinds) => {
      if (notifying) {
        notifying = false;
        return;
      }
      if (kinds.includes('status') || kinds.includes('head') || kinds.includes('sequence')) poller.resync();
    }),
  ];
  // The first read is the baseline
  poller.poke();
  update();
  return new vscode.Disposable(() => {
    poller.dispose();
    for (const s of subs) s.dispose();
  });
}
