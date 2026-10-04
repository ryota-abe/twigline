import type { RefComparison, RefInfo, WorkingTreeStatus } from '../../../shared/protocol';
import { dirtyPaths } from './integrate';

// What a reset of the current branch to a commit would do.
//  back: commits are taken off the branch (the usual "undo commits"), forward: the branch moves ahead to a descendant,
//  sideways: both (the commit is on another line of history), same: the same commit (only the index / working tree change)

export type ResetMode = 'soft' | 'mixed' | 'hard';
export type ResetState = 'loading' | 'unknown' | 'same' | 'back' | 'forward' | 'sideways';

export interface ResetStatus {
  state: ResetState;
  /** Commits taken off the branch / brought onto it */
  removed: number;
  added: number;
  /** Removed commits that no other branch, tag or remote has, so only the reflog keeps them; undefined until known */
  orphaned?: number;
  /** Removed commits that are already on the upstream: the next push needs force */
  pushedRemoved: number;
  /** Tracked files with uncommitted changes (what a hard reset discards) */
  discarded: number;
  /** Files with staged changes (what a mixed reset to the same commit unstages) */
  staged: number;
  /** The reset would change nothing */
  nothing: boolean;
}

export function resetStatus(opts: {
  /** The current branch; undefined on a detached HEAD */
  local: RefInfo | undefined;
  /** HEAD (ours) compared with the target commit (theirs) */
  cmp: RefComparison | null | undefined;
  /** The target commit (ours) compared with the upstream of the branch (theirs); undefined without an upstream or while loading */
  toUpstream: RefComparison | null | undefined;
  orphaned: number | null | undefined;
  mode: ResetMode;
  status: WorkingTreeStatus | null;
}): ResetStatus {
  const { local, cmp, toUpstream, mode, status } = opts;
  const discarded = status ? dirtyPaths(status).length : 0;
  const staged = status?.staged.length ?? 0;
  const base = { removed: 0, added: 0, orphaned: opts.orphaned ?? undefined, pushedRemoved: 0, discarded, staged };
  if (cmp === undefined) return { ...base, state: 'loading', nothing: false };
  if (cmp === null) return { ...base, state: 'unknown', nothing: false };

  const removed = cmp.ahead;
  const added = cmp.behind;
  const state: ResetState = removed === 0 && added === 0 ? 'same' : added === 0 ? 'back' : removed === 0 ? 'forward' : 'sideways';
  // Commits the upstream has beyond the target, minus those only the upstream has (never on this branch): the pushed ones taken off.
  // Exact when the target is an ancestor of HEAD (back); an upper estimate otherwise
  const tracked = !!local?.upstream && !local.gone;
  const pushedRemoved = tracked && toUpstream && removed > 0 ? Math.min(removed, Math.max(0, toUpstream.behind - (local.behind ?? 0))) : 0;
  const nothing = state === 'same' && (mode === 'soft' || (mode === 'mixed' && staged === 0) || (mode === 'hard' && discarded === 0));
  return { ...base, state, removed, added, pushedRemoved, nothing };
}
