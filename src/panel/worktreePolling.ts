import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChangeKind } from '../../shared/protocol';
import { isSameOrInside } from '../repo/repoId';
import type { RepoModel } from '../repo/RepoModel';
import { headChanged, StatusPoller, statusFingerprint } from '../repo/statusPoller';

/**
 * Working tree changes of a repository vscode.git does not know (an other repository, outside the workspace), without watching its folder.
 * `git status` is read again when the window gets focus or the panel becomes visible, when a file in the repository is saved,
 * created, deleted or renamed in VS Code, and every few seconds while the panel is visible and the window has focus
 * (for programs that change files meanwhile, such as a build in the terminal). The panel is told only when the result differs.
 */
export function pollWorktree(model: RepoModel, panel: vscode.WebviewPanel): vscode.Disposable {
  const poller = new StatusPoller({
    read: async ({ resync }) => {
      if (model.busy) return undefined;
      // A resync follows a notification that already dropped the cache, and the panel reads the status for it too: share that read
      if (!resync) model.status.invalidate();
      return statusFingerprint(model.root, model.gitDir, await model.status.getParsed());
    },
    onChange: (previous, current) => {
      // HEAD moved (a commit or checkout in a terminal, which the .git watcher can miss on a network drive): the history too
      const kinds: ChangeKind[] = headChanged(previous, current) ? ['head', 'refs', 'status'] : ['status'];
      model.notifyChanged(kinds);
    },
  });
  const update = () => poller.setActive(panel.visible && vscode.window.state.focused);
  const touches = (uris: readonly vscode.Uri[]) => uris.some((u) => u.scheme === 'file' && isSameOrInside(realPath(u.fsPath), model.root));
  const poke = (uris: readonly vscode.Uri[]) => touches(uris) && poller.poke();
  const subs: { dispose(): void }[] = [
    panel.onDidChangeViewState(update),
    vscode.window.onDidChangeWindowState(update),
    vscode.workspace.onDidSaveTextDocument((d) => poke([d.uri])),
    vscode.workspace.onDidCreateFiles((e) => poke(e.files)),
    vscode.workspace.onDidDeleteFiles((e) => poke(e.files)),
    vscode.workspace.onDidRenameFiles((e) => poke(e.files.flatMap((f) => [f.oldUri, f.newUri]))),
    // Changes the panel was told about some other way (Twigline's operations, the .git watcher, this poller): the new baseline.
    // The read shares the cache with the panel, so it runs no extra git
    model.onDidChange((kinds) => {
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

/**
 * The path with its folder's symbolic links resolved: git reports the real path of the root, and a file may be opened through a link
 * (the folder, not the file: a deleted file has none)
 */
function realPath(p: string): string {
  try {
    return path.join(realpathSync.native(path.dirname(p)), path.basename(p));
  } catch {
    return p;
  }
}
