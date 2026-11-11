# Changelog

## 1.0.0-beta.4

A pre-release of 1.0.0: a clearer interactive rebase dialog.

- The interactive rebase list keeps git's order (oldest first, the reverse of the history graph); a faint line now runs from the base at the top to the new tip of the branch at the bottom, with a dot per commit, and squash and fixup rows are tied to the row above
- The action of each row shows only its name (`pick`, `squash`, …) while closed; what each action does is shown in the open list and in the tooltip
- The move buttons of a row are shown only while the pointer is over it or it has focus
- Fixed: in a narrow panel, the tabs changed height when switching between Uncommitted Changes and History, because the History view's search box wrapped to a second line

## 1.0.0-beta.3

A pre-release of 1.0.0: GitLab merge requests, and checking out a branch from the graph.

- Merge requests on GitLab (gitlab.com, and self-managed GitLab on a `gitlab.*` host, including projects in nested groups) are shown on their branches like pull requests, with a `!12` badge. Merge requests from forks are told apart. A private project asks for a personal access token (`read_api`) for that server, kept per host in the secret storage; "Disconnect from GitLab" in the Command Palette removes the saved tokens
- The push, reset, merge / rebase and branch deletion dialogs refer to a merge request as `!12`, as the badge does
- Double-clicking a local branch badge in the graph (or in the commit details) checks it out, as a double-click in the sidebar does; a remote branch badge opens the checkout dialog. A spinner marks the branch while the checkout runs, and the branch flashes briefly once HEAD is on it. A branch checked out in another worktree is not checked out; a toast names that worktree instead
- Fixed: saving "Commit Message Links…" failed with "… is not a registered configuration" in a window that was not reloaded after Twigline was updated; it now says to reload the window

## 1.0.0-beta.2

A pre-release of 1.0.0: links in commit messages.

- In the commit details, http(s) URLs in the message open in the browser
- References to issues and pull requests can be links too, following the conventions of the remote's hosting service (upstream first, then origin): `#123`, `GH-123` and `owner/repo#123` on GitHub, `#123` and `!123` on GitLab, `#123` and "pull request #123" on Bitbucket Cloud, `#123` (work item), `!123` and "Merged PR 123" on Azure DevOps. They are off by default (`twigline.issueLinks.builtIn`), because `#123` points to the wrong place when a project tracks issues elsewhere
- New setting `twigline.issueLinks.trackers`: issue trackers by type, tried before the built-in references: Jira, Backlog, YouTrack and Linear (keys like `PROJ` in `PROJ-123`), Redmine (`#123`), Azure Boards (`AB#123`), the issues of another GitHub repository, or a custom regular expression and URL. The settings can differ for each folder of a multi-root workspace
- "Commit Message Links…" sets these up without writing regular expressions: add a tracker by type, enter its URL, and pick project keys from those used in recent commits (with how often they appear, so text like `UTF-8` is easy to leave out). It shows how many links each tracker makes in recent commits, and what the selected commit's message would link, before saving to the workspace folder (`.vscode/settings.json`) or the user settings. It opens from "…" in the panel, the Command Palette, Repository Settings, and a link button shown when the pointer is over a commit message
- Nothing is read from the hosting service; the host finds the links in the commit's message again and opens only http(s) URLs among them

## 1.0.0-beta.1

A pre-release of 1.0.0: repositories outside the workspace, and fetching from the sidebar.

- "Open Repository from Folder…" (title of the repository list, Command Palette, and the repository picker) opens any folder. A repository outside the workspace is opened only after a confirmation naming its root, because Workspace Trust does not cover it and git can run programs set in the repository (hooks, `core.fsmonitor`)
- Repositories opened that way are listed under "Other Repositories" at the end of the repository list in every window, with "Remove from List"; a folder that is gone is not opened and can be removed from the list. Their changes are noticed by reading `git status` while their panel is open (on focus, on save, and every few seconds while visible) instead of watching the folder
- The Remotes heading in the sidebar has a fetch button (all remotes), each remote row has one for that remote, and right-clicking a remote gives Fetch, Fetch... and Edit Remote...; these fetches prune deleted remote branches
- Fixed: deleting a branch "from the remote too" failed with "remote ref does not exist" when the branch had already been deleted on the remote (e.g. by merging its PR); it now counts as done and removes the stale remote-tracking branch
- The description and the README say what Twigline is and what sets it apart

## 0.7.0

Opening a terminal for the repository, and a check before creating a pull request.

- "…" at the right end of the tab row has "Open in Integrated Terminal" (also in the Command Palette while a Twigline panel is frontmost)
- "Open in Integrated Terminal", from the panel or the repository list, shows a terminal already open in the repository instead of opening another
- New setting `twigline.terminal.profile`: the terminal profile "Open in Integrated Terminal" uses, by its name (e.g. `Git Bash`), or `default` for VS Code's default profile. When it is empty, Git Bash is opened on Windows if Git for Windows is installed and no default terminal profile is chosen in VS Code; otherwise VS Code's default profile
- "Create Pull Request" warns when the branch has not been pushed yet, with "Push…" to open the push dialog, instead of opening the compare page for a branch the remote does not have; when the branch has unpushed commits it warns too, with "Open Anyway"
- "Create Pull Request" is no longer shown in repositories with no remote

## 0.6.3

A fix for the lists of checkboxes in dialogs.

- Fixed: the list of branches on the "Delete Branches" tab of the Branch dialog (and the list of files in "Discard Changes") could shrink to almost nothing when the dialog reached its maximum height; the list now keeps its height and the dialog scrolls instead

## 0.6.2

Checking out a remote branch from the history.

- "Checkout..." on a commit in the history now also lists the remote branches at that commit, and creates a local branch tracking the chosen one (its name can be edited); a commit with only a remote branch could be checked out only as a detached HEAD before. A remote branch that a local branch at the same commit already covers (same name, or tracking it) is not listed again

## 0.6.1

Stashes with untracked files, and telling stashes apart.

- Fixed: the details of a stash made with untracked files (`--include-untracked` or `--all`) listed only the tracked changes; the untracked files are now listed too (status `?`), and their diff opens from the stash
- The sidebar shows each stash's `stash@{n}` next to its message, so stashes with the same message (every autostash is "autostash") can be told apart

## 0.6.0

The repository list in the Activity Bar shows each repository's state and gets its own actions.

- Each row shows the number of changed files as a badge, and a rebase, merge, cherry-pick or revert that has stopped ("Rebasing 3/7" etc., yellow; red with `!` when there are conflicts); hovering a row shows the path and the staged / unstaged / untracked / conflicted counts
- Rows have fetch / pull / push buttons, and a context menu with Open in Twigline, fetch / pull / push, Open in Integrated Terminal and Copy Path; fetch / pull / push act on that row's repository instead of asking
- The gear in the title of the list opens Twigline's settings
- Pushing from the repository list or the Command Palette now asks first, naming the branch and where it goes (and that the remote branch will be created when there is no upstream yet)
- "Open Repository in Twigline" from the Command Palette now always asks which repository when there is more than one, with the active panel's repository at the top; it used to reopen the active panel's repository

## 0.5.3

A fix for the message filled in by Amend.

- Fixed: checking "Amend last commit" could fill the commit box with the message of an older commit when the last commit was made outside Twigline (in a terminal or the Source Control view), or when it was checked right after opening the Uncommitted Changes tab; the message is now read from HEAD when it is checked
- Development: the `npm run dev:web` server now answers only its own page on localhost

## 0.5.2

Fixes for "Stash and Continue" when a file is in the way of an operation.

- Fixed: ignored files in the way were not stashed, so "Stash and Continue" saved nothing and failed the same way again; the ignored files are now stashed, and when nothing could be stashed the dialog says so instead of running the operation again
- Fixed: untracked files saved by "Stash and Continue" stayed in the working tree, so the operation failed again
- Fixed: a rebase that stopped on a file in the way failed with "a rebase-merge directory already exists" after "Stash and Continue"; the rebase is now continued
- Fixed: a cherry-pick or revert of several commits that stopped on a file in the way was not shown as in progress, and running it again failed; it is now shown with its banner, "Stash and Continue" continues it, and continuing no longer drops the commit that was not applied

## 0.5.1

Fixes for the dialogs added in 0.5.0.

- Fixed: a merge or a pull that creates a merge commit failed when there were staged changes; the dialog now asks for them to be stashed first
- Fixed: branches checked out in another worktree were offered for deletion, which git refuses; they are now shown disabled with an "In another worktree" badge
- Fixed: every force push failed on git before 2.30, which does not know `--force-if-includes`
- Fixed: choosing another remote in Push or Pull kept the first remote's branch name, so a push to a fork could go to the wrong branch
- Fixed: the rebase dialog said "No conflicts expected" as a fact, although a rebase can still conflict on an intermediate commit
- Fixed: the Push Branches summary could read "0 commits to push" when only new branches were selected
- The README opens with a screenshot of the History tab

## 0.5.0

Dialogs now show what an operation would do before it runs.

- Push: the route, ahead / behind against the remote branch, the pull request of the target branch, and whether a force push is required (OK stays disabled until force is checked, and the confirmation names how many remote commits would be lost)
- Push Branches: per-branch state against the remote (ahead / behind, new, up to date, deleted) and its pull request; branches that need force are highlighted and only those that can be pushed without force are selected by default
- Pull: what happens in the chosen mode (fast-forward, merge commit or rebase), predicted conflicts, pushed commits a rebase would rewrite, untracked files in the way; merge / rebase / fast-forward only is a radio group, and `--autostash` is offered when local changes are in the way
- Merge and Rebase: what happens (fast-forward, merge commit, squash, or how many commits are recreated), predicted conflicts, and the pull request involved; merge gains a mode choice and `--autostash`, and a rebase of pushed commits warns that the next push needs force
- Delete Branch: whether each branch is merged and pushed, a "Select Merged" button, and warnings for branches `git branch -d` would refuse and for open pull requests that deleting a remote branch would close
- Reset: how many commits are taken off and brought on and where their changes go in the chosen mode, with warnings for commits no branch, tag or remote branch would still have and for pushed commits taken off
- A rejected push offers "Fetch and Review", which fetches and reopens the push dialog
- Fixed: switching the remote in Push Branches kept the first remote's branch names and selection
- Fixed: deleting a remote branch that is already deleted no longer fails

## 0.4.0

First public release.

- One panel per repository with "Uncommitted Changes" and "History" tabs
- Commit graph with branch, remote branch, tag and stash lists; history search by message, author, content and path; file history
- Selecting a commit slightly emphasizes its branch in the graph, from where the tree forks to where it is merged (or to its tip if it is not merged yet)
- Stage, unstage and discard by file, hunk or line; commit, amend, stash
- Merge, rebase (including interactive), cherry-pick, revert, reset, tags, conflict resolution
- Dialogs that preview the git command before it runs
- Pull request badges for GitHub (including GitHub Enterprise Server) and Bitbucket Cloud
- Syntax-highlighted diffs using the grammars and color theme installed in VS Code
- English and Japanese UI; Japanese file names and Shift_JIS / EUC-JP files
