import type { RefComparison, RefInfo, WorkingTreeStatus } from '../../../shared/protocol';
import { integrateStatus, type IntegrateState, type IntegrateStatus } from './integrate';

// What a pull would do, judged from the remote-tracking branch as of the last fetch and the working tree.
// The pull fetches first, so this can only be a forecast: nothing is disabled on a guess that a fetch could change,
// only on what a fetch cannot fix (diverged histories with fast-forward only, local changes git refuses to pull over).
//  notFetched: there is no remote-tracking branch for it (git fetches it at pull), loading: the comparison has not arrived,
//  unknown: it could not be compared (no commit to pull into yet, or the comparison failed),
//  upToDate / fastForward / diverged: compared with the remote-tracking branch, unrelated: no common history

export type PullMode = 'merge' | 'rebase' | 'ffOnly';
export type PullState = 'notFetched' | IntegrateState;

export interface PullStatus extends Omit<IntegrateStatus, 'state'> {
  state: PullState;
  /** A fast-forward-only pull is known to fail (diverged or unrelated histories) */
  ffImpossible: boolean;
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
  const s = integrateStatus(opts);
  if (!opts.remoteRef) return { ...s, state: 'notFetched', ahead: 0, behind: 0, rewritesPushed: false, overlap: [], untrackedOverlap: [], conflicts: undefined, ffImpossible: false };
  return { ...s, ffImpossible: s.state === 'diverged' || s.state === 'unrelated' };
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
