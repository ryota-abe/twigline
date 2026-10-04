# Changelog

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
