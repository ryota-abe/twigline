import type { PullRequestInfo, PullRequestList, RefComparison, RefInfo } from '../../../shared/protocol';

// What a push of one local branch would do, judged from the refs read at the last fetch (nothing is asked of the remote).
//  new: the remote branch does not exist (or its upstream is gone), upToDate / ahead / behind / diverged: compared with the remote branch,
//  unknown: the remote branch exists but is not the branch's upstream, so the difference is not known until it is compared on the host
//  (pushComparePair gives the commits to compare; pass the result as cmp)

export type PushState = 'new' | 'upToDate' | 'ahead' | 'behind' | 'diverged' | 'gone' | 'unknown';

export interface PushStatus {
  state: PushState;
  /** Commits only the local branch has / only the remote branch has. 0 unless state is ahead, behind or diverged */
  ahead: number;
  behind: number;
  /** A push without force is rejected (the remote branch has commits the local branch does not) */
  forceRequired: boolean;
}

export function pushStatus(local: RefInfo, refs: readonly RefInfo[], remote: string, remoteName: string, cmp?: RefComparison | null): PushStatus {
  const target = `${remote}/${remoteName}`;
  const done = (state: PushState, ahead = 0, behind = 0): PushStatus => ({ state, ahead, behind, forceRequired: behind > 0 });
  const compared = (ahead: number, behind: number): PushStatus =>
    ahead > 0 && behind > 0 ? done('diverged', ahead, behind) : behind > 0 ? done('behind', 0, behind) : ahead > 0 ? done('ahead', ahead) : done('upToDate');
  if (local.upstream === target) {
    if (local.gone) return done('gone');
    return compared(local.ahead ?? 0, local.behind ?? 0);
  }
  const remoteRef = refs.find((r) => r.kind === 'remote' && r.name === target);
  if (!remoteRef) return done('new');
  if (remoteRef.sha === local.sha) return done('upToDate');
  // Only a comparison of these very commits counts (one made before a ref moved is ignored)
  if (cmp && cmp.ours === local.sha && cmp.theirs === remoteRef.sha) return compared(cmp.ahead, cmp.behind);
  return done('unknown');
}

/** The commits to compare on the host when pushStatus cannot tell from the refs alone (the remote branch is not the upstream) */
export function pushComparePair(local: RefInfo, refs: readonly RefInfo[], remote: string, remoteName: string): [string, string] | undefined {
  const target = `${remote}/${remoteName}`;
  if (local.upstream === target) return undefined;
  const remoteRef = refs.find((r) => r.kind === 'remote' && r.name === target);
  return remoteRef && remoteRef.sha !== local.sha ? [local.sha, remoteRef.sha] : undefined;
}

/**
 * Defaults of a branch's row when pushing several branches to this remote: the name of its upstream there (else the same name),
 * selected when it has commits to push and nothing only on the remote, tracking when it has no upstream yet
 */
export function pushRowDefaults(local: RefInfo, remote: string): { remote: string; checked: boolean; track: boolean } {
  const up = local.upstream?.startsWith(remote + '/') ? local.upstream.slice(remote.length + 1) : undefined;
  return { remote: up ?? local.name, checked: !!up && !local.gone && (local.ahead ?? 0) > 0 && (local.behind ?? 0) === 0, track: !local.upstream };
}

/** The PR of the branch a push goes to: looked up by the remote branch, or by the local branch when that is its upstream */
export function pullRequestFor(
  list: PullRequestList | null,
  local: RefInfo,
  remote: string,
  remoteName: string,
): { pr: PullRequestInfo; ref: string } | undefined {
  const target = `${remote}/${remoteName}`;
  for (const ref of [`refs/remotes/${target}`, ...(local.upstream === target ? [local.fullName] : [])]) {
    const pr = list?.byRef[ref];
    if (pr) return { pr, ref };
  }
  return undefined;
}
