import type { RefComparison, RefInfo, WorkingTreeStatus } from '../../../shared/protocol';

// What a pull would do, judged from the remote-tracking branch as of the last fetch and the working tree.
// The pull fetches first, so this can only be a forecast: nothing is disabled on a guess that a fetch could change,
// only on what a fetch cannot fix (diverged histories with fast-forward only, local changes git refuses to pull over).
//  notFetched: there is no remote-tracking branch for it (git fetches it at pull), loading: the comparison has not arrived,
//  unknown: it could not be compared (no commit to pull into yet, or the comparison failed),
//  upToDate / fastForward / diverged: compared with the remote-tracking branch, unrelated: no common history

export type PullMode = 'merge' | 'rebase' | 'ffOnly';
export type PullState = 'notFetched' | 'loading' | 'unknown' | 'upToDate' | 'fastForward' | 'diverged' | 'unrelated';

export interface PullStatus {
  state: PullState;
  /** Commits only the local branch has / only the remote branch has */
  ahead: number;
  behind: number;
  /** A fast-forward-only pull is known to fail (diverged or unrelated histories) */
  ffImpossible: boolean;
  /** A rebase would rewrite commits that are already on the branch's upstream, so the next push needs force */
  rewritesPushed: boolean;
  /** Paths changed in the working tree or index (tracked files) */
  dirty: string[];
  /** Dirty paths the incoming commits also change: git refuses a merge over them unless they are stashed */
  overlap: string[];
  /** Untracked paths the incoming commits add: the pull fails until they are moved, and autostash does not take them */
  untrackedOverlap: string[];
  /** Paths predicted to conflict (diverged only; null when it cannot be predicted, undefined until known) */
  conflicts?: string[] | null;
}

export function pullStatus(opts: {
  /** The branch pulled into (HEAD's branch) */
  local: RefInfo | undefined;
  /** remote/branch */
  target: string;
  /** The remote-tracking branch, if fetched */
  remoteRef: RefInfo | undefined;
  /** Comparison of the local branch (ours) with the remote-tracking branch (theirs); undefined while loading, null when not known */
  cmp: RefComparison | null | undefined;
  /** Working tree status; null when the branch is not checked out (the working tree is not involved) */
  status: WorkingTreeStatus | null;
}): PullStatus {
  const { local, target, remoteRef, cmp, status } = opts;
  const dirty = status ? dirtyPaths(status) : [];
  const untracked = status ? status.unstaged.filter((f) => f.status === '?').map((f) => f.path) : [];
  const base = { ahead: 0, behind: 0, ffImpossible: false, rewritesPushed: false, dirty, overlap: [], untrackedOverlap: [] };
  if (!remoteRef) return { ...base, state: 'notFetched' };
  if (cmp === undefined) return { ...base, state: 'loading' };
  if (cmp === null) return { ...base, state: 'unknown' };

  const incoming = new Set(cmp.incomingFiles ?? []);
  const overlap = dirty.filter((p) => incoming.has(p));
  const untrackedOverlap = untracked.filter((p) => incoming.has(p));
  const s = { ...base, ahead: cmp.ahead, behind: cmp.behind, overlap, untrackedOverlap, conflicts: cmp.conflicts };
  if (cmp.behind === 0) return { ...s, state: 'upToDate' };
  if (cmp.ahead === 0) return { ...s, state: 'fastForward' };
  if (!cmp.mergeBase) return { ...s, state: 'unrelated', ffImpossible: true };
  // Commits a rebase rewrites: those only the local branch has (ahead). Fewer of them are unpushed than that when the
  // upstream is another branch (pulling main into a feature branch that is pushed to its own remote branch)
  const rewritesPushed = !!local?.upstream && local.upstream !== target && !local.gone && (local.ahead ?? 0) < cmp.ahead;
  return { ...s, state: 'diverged', ffImpossible: true, rewritesPushed };
}

/** Tracked paths with changes in the index or working tree */
export function dirtyPaths(status: WorkingTreeStatus): string[] {
  const set = new Set<string>();
  for (const f of [...status.staged, ...status.unstaged, ...status.conflicted]) if (f.status !== '?') set.add(f.path);
  return [...set];
}

/**
 * What must be settled before this pull can run. Settled by switching the mode (ff), stashing local changes (stash), or not at all (unrelated).
 * stash does not look at autostash: the dialog keeps showing the requirement while autostash settles it
 */
export function pullRequirement(s: PullStatus, mode: PullMode): 'ff' | 'stash' | 'unrelated' | null {
  if (s.state === 'unrelated') return 'unrelated';
  if (mode === 'ffOnly' && s.ffImpossible) return 'ff';
  // git pull --rebase refuses any local change; a merge only refuses changes in the files it updates
  if (mode === 'rebase' && s.dirty.length > 0) return 'stash';
  if (s.overlap.length > 0) return 'stash';
  return null;
}
