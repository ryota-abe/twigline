// Context menus. Right-click commands are passed to the webview as they are;
// confirmation dialogs that show the name of the target and the handling of several selected commits are done on the webview side.
// (This file does not import vscode. Consistency with package.json is checked by a test)

export const MENU_COMMANDS = [
  // commit
  'twigline.commit.checkout',
  'twigline.commit.createBranch',
  'twigline.commit.createTag',
  'twigline.commit.merge',
  'twigline.commit.rebase',
  'twigline.commit.cherryPick',
  'twigline.commit.revert',
  'twigline.commit.reset',
  'twigline.commit.interactiveRebase',
  'twigline.commit.copySha',
  'twigline.commit.copyMessage',
  'twigline.commit.createPatch',
  'twigline.commit.customAction',
  // branch.local
  'twigline.branch.checkout',
  'twigline.branch.createBranch',
  'twigline.branch.merge',
  'twigline.branch.rebase',
  'twigline.branch.pull',
  'twigline.branch.push',
  'twigline.branch.setUpstream',
  'twigline.branch.compare',
  'twigline.branch.rename',
  'twigline.branch.delete',
  'twigline.branch.createPullRequest',
  'twigline.branch.openPullRequest',
  // branch.remote
  'twigline.remoteBranch.checkout',
  'twigline.remoteBranch.createBranch',
  'twigline.remoteBranch.merge',
  'twigline.remoteBranch.compare',
  'twigline.remoteBranch.delete',
  'twigline.remoteBranch.openPullRequest',
  // tag
  'twigline.tag.checkout',
  'twigline.tag.createBranch',
  'twigline.tag.showDetails',
  'twigline.tag.push',
  'twigline.tag.delete',
  // stash
  'twigline.stash.apply',
  'twigline.stash.pop',
  'twigline.stash.showDiff',
  'twigline.stash.createBranch',
  'twigline.stash.drop',
  // file.unstaged, file.staged
  'twigline.file.stage',
  'twigline.file.unstage',
  'twigline.file.discard',
  'twigline.file.ignore',
  'twigline.file.openDiff',
  'twigline.file.open',
  'twigline.file.history',
  'twigline.file.reveal',
  'twigline.file.copyPath',
  // file.conflicted
  'twigline.file.resolveCurrent',
  'twigline.file.resolveIncoming',
  'twigline.file.openMergeEditor',
  'twigline.file.markResolved',
  'twigline.file.markUnresolved',
  // file.commit
  'twigline.commitFile.openRevision',
  'twigline.commitFile.compareWorktree',
  'twigline.commitFile.restore',
] as const;

export type MenuCommand = (typeof MENU_COMMANDS)[number];

/**
 * Actions inside the panel. Passed to the webview of the frontmost Twigline panel.
 * On screen they are placed by the scope they work on (not in the editor title bar, which has VS Code's own buttons at a different level).
 * - Current branch (pull, push, merge, rebase): the menu on the current branch name in the tab row
 * - Working tree (stash, discard): inside the "Uncommitted Changes" tab
 * - Whole repository (fetch, push branches, branch, tag, settings): "..." in the tab row
 * They appear in the Command Palette only while a Twigline panel is frontmost (pull, push and fetch are omitted because twigline.pull etc. exist)
 */
export const PANEL_COMMANDS = [
  'twigline.panel.pull',
  'twigline.panel.push',
  'twigline.panel.merge',
  'twigline.panel.rebase',
  'twigline.panel.stash',
  'twigline.panel.discard',
  'twigline.panel.fetch',
  'twigline.panel.pushBranches',
  'twigline.panel.branch',
  'twigline.panel.tag',
  'twigline.panel.settings',
] as const;

/** Commands that are also shown in the Command Palette */
export const PALETTE_COMMANDS = [
  'twigline.open',
  'twigline.fetch',
  'twigline.pull',
  'twigline.push',
  'twigline.fileHistory',
  'twigline.refresh',
  'twigline.view.fileStatus',
  'twigline.view.history',
  'twigline.view.search',
  'twigline.optimize',
  'twigline.showOutput',
  'twigline.bitbucket.signOut',
] as const;
