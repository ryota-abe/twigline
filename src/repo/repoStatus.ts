import type { SequenceState, WorkingTreeStatus } from '../../shared/protocol';
import type { RepositoryState } from '../types/git';
import { findGitDir, readSequenceIn } from './sequence';

/** What the repository list shows for a repository without opening it (the state of vscode.git and files in the git directory; git is not run) */
export interface RepoStatus {
  conflicts: number;
  staged: number;
  unstaged: number;
  untracked: number;
  /** Files with any change, each counted once (a file both staged and modified is one) */
  changed: number;
  sequence: SequenceState | null;
}

type Changes = Pick<RepositoryState, 'mergeChanges' | 'indexChanges' | 'workingTreeChanges' | 'untrackedChanges'>;

export function repoStatus(root: string, state: Changes | undefined): RepoStatus {
  const lists = [state?.mergeChanges, state?.indexChanges, state?.workingTreeChanges, state?.untrackedChanges].map((l) => l ?? []);
  const gitDir = findGitDir(root);
  return {
    conflicts: lists[0].length,
    staged: lists[1].length,
    unstaged: lists[2].length,
    untracked: lists[3].length,
    changed: new Set(lists.flat().map((c) => c.uri.toString())).size,
    sequence: gitDir ? readSequenceIn(gitDir) : null,
  };
}

/**
 * The same for a repository vscode.git does not know (one outside the workspace): from Twigline's own `git status` of the open panel.
 * `gitDir` is the git directory of the open repository.
 */
export function repoStatusFromWorkingTree(gitDir: string, status: WorkingTreeStatus): RepoStatus {
  const untracked = status.unstaged.filter((f) => f.status === '?').length;
  return {
    conflicts: status.conflicted.length,
    staged: status.staged.length,
    unstaged: status.unstaged.length - untracked,
    untracked,
    changed: new Set([...status.conflicted, ...status.staged, ...status.unstaged].map((f) => f.path)).size,
    sequence: readSequenceIn(gitDir),
  };
}

/** A file decoration badge holds one or two characters */
export function countBadge(n: number): string | undefined {
  if (n <= 0) return undefined;
  return n > 99 ? '9+' : String(n);
}
