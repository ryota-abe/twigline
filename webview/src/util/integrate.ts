import type { RefComparison, RefInfo, WorkingTreeStatus } from '../../../shared/protocol';

// What bringing another commit into the current branch would do (pull, merge, rebase), judged from a comparison on the host
// (ours: the branch, theirs: what is brought in) and the working tree.
//  loading: the comparison has not arrived, unknown: it could not be compared (no commit yet, or the comparison failed),
//  upToDate: nothing to bring in, fastForward: the branch only needs to move forward, diverged: both sides have commits,
//  unrelated: no common history

export type IntegrateState = 'loading' | 'unknown' | 'upToDate' | 'fastForward' | 'diverged' | 'unrelated';

export interface IntegrateStatus {
  state: IntegrateState;
  /** Commits only the branch has / only the other side has */
  ahead: number;
  behind: number;
  /** A rebase would rewrite commits that are already on the branch's upstream, so the next push needs force */
  rewritesPushed: boolean;
  /** Paths changed in the working tree or index (tracked files) */
  dirty: string[];
  /** Paths with changes in the index: git refuses a merge that creates a merge commit over any of them */
  staged: string[];
  /** Dirty paths the incoming commits also change: git refuses a merge over them unless they are stashed */
  overlap: string[];
  /** Untracked paths the incoming commits add: git refuses until they are moved, and autostash does not take them */
  untrackedOverlap: string[];
  /** Paths predicted to conflict (diverged only; null when it cannot be predicted, undefined until known) */
  conflicts?: string[] | null;
}

export function integrateStatus(opts: {
  /** The branch brought into (HEAD's branch); undefined on a detached HEAD */
  local: RefInfo | undefined;
  /** Name of what is brought in (remote/branch, a branch, a tag...) */
  target: string;
  /** Comparison of the branch (ours) with what is brought in (theirs); undefined while loading, null when not known */
  cmp: RefComparison | null | undefined;
  /** Working tree status; null when the branch is not checked out (the working tree is not involved) */
  status: WorkingTreeStatus | null;
}): IntegrateStatus {
  const { local, target, cmp, status } = opts;
  const dirty = status ? dirtyPaths(status) : [];
  const staged = status ? [...new Set(status.staged.map((f) => f.path))] : [];
  const base = { ahead: 0, behind: 0, rewritesPushed: false, dirty, staged, overlap: [], untrackedOverlap: [] };
  if (cmp === undefined) return { ...base, state: 'loading' };
  if (cmp === null) return { ...base, state: 'unknown' };

  const incoming = new Set(cmp.incomingFiles ?? []);
  const untracked = status ? status.unstaged.filter((f) => f.status === '?').map((f) => f.path) : [];
  const s = {
    ...base,
    ahead: cmp.ahead,
    behind: cmp.behind,
    overlap: dirty.filter((p) => incoming.has(p)),
    untrackedOverlap: untracked.filter((p) => incoming.has(p)),
    conflicts: cmp.conflicts,
  };
  if (cmp.behind === 0) return { ...s, state: 'upToDate' };
  if (cmp.ahead === 0) return { ...s, state: 'fastForward' };
  // Commits a rebase rewrites: those only the branch has (ahead). Fewer of them are unpushed than that when the
  // upstream is another branch (bringing main into a feature branch that is pushed to its own remote branch)
  const rewritesPushed = !!local?.upstream && local.upstream !== target && !local.gone && (local.ahead ?? 0) < cmp.ahead;
  return { ...s, state: cmp.mergeBase ? 'diverged' : 'unrelated', rewritesPushed };
}

/** Tracked paths with changes in the index or working tree */
export function dirtyPaths(status: WorkingTreeStatus): string[] {
  const set = new Set<string>();
  for (const f of [...status.staged, ...status.unstaged, ...status.conflicted]) if (f.status !== '?') set.add(f.path);
  return [...set];
}

export type MergeMode = 'auto' | 'noFf' | 'squash';

/** The merge creates a merge commit (not a fast-forward; --squash on a fast-forward checks out like one) */
export function makesMergeCommit(s: Pick<IntegrateStatus, 'state'>, mode: MergeMode): boolean {
  return s.state === 'diverged' || (s.state === 'fastForward' && mode === 'noFf');
}

/**
 * Local changes a merge refuses to run over: changes in the files it updates, and, when it creates a merge commit,
 * any change in the index (git merge requires the index to match HEAD then, even for files the merge does not touch).
 * staged lists only the paths not already in overlap
 */
export function mergeStashPaths(s: Pick<IntegrateStatus, 'overlap' | 'staged'>, mergeCommit: boolean): { overlap: string[]; staged: string[] } {
  const overlap = new Set(s.overlap);
  return { overlap: s.overlap, staged: mergeCommit ? s.staged.filter((p) => !overlap.has(p)) : [] };
}

/**
 * What must be settled before this merge can run: local changes it refuses to run over (stash), or no common history (unrelated).
 * stash does not look at autostash: the dialog keeps showing the requirement while autostash settles it
 */
export function mergeRequirement(s: IntegrateStatus, mode: MergeMode): 'stash' | 'unrelated' | null {
  // git merge refuses unrelated histories (it would need --allow-unrelated-histories)
  if (s.state === 'unrelated') return 'unrelated';
  const paths = mergeStashPaths(s, makesMergeCommit(s, mode));
  if (paths.overlap.length > 0 || paths.staged.length > 0) return 'stash';
  return null;
}

/** git rebase refuses any local change to tracked files (unless autostash). Not asked when the rebase would change nothing */
export function rebaseRequirement(s: IntegrateStatus): 'stash' | null {
  return s.state !== 'upToDate' && s.dirty.length > 0 ? 'stash' : null;
}
