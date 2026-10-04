import type { PullRequestInfo, PullRequestList, RefInfo } from '../../../shared/protocol';

// What a push of one local branch would do, judged from the refs read at the last fetch (nothing is asked of the remote).
//  new: the remote branch does not exist (or its upstream is gone), upToDate / ahead / behind / diverged: compared with the remote branch,
//  unknown: the remote branch exists but is not the branch's upstream, so the difference is not known (it needs a host-side comparison)

export type PushState = 'new' | 'upToDate' | 'ahead' | 'behind' | 'diverged' | 'gone' | 'unknown';

export interface PushStatus {
  state: PushState;
  /** Commits only the local branch has / only the remote branch has. 0 unless state is ahead, behind or diverged */
  ahead: number;
  behind: number;
  /** A push without force is rejected (the remote branch has commits the local branch does not) */
  forceRequired: boolean;
}

export function pushStatus(local: RefInfo, refs: readonly RefInfo[], remote: string, remoteName: string): PushStatus {
  const target = `${remote}/${remoteName}`;
  const done = (state: PushState, ahead = 0, behind = 0): PushStatus => ({ state, ahead, behind, forceRequired: behind > 0 });
  if (local.upstream === target) {
    if (local.gone) return done('gone');
    const ahead = local.ahead ?? 0;
    const behind = local.behind ?? 0;
    if (ahead > 0 && behind > 0) return done('diverged', ahead, behind);
    if (behind > 0) return done('behind', 0, behind);
    return ahead > 0 ? done('ahead', ahead) : done('upToDate');
  }
  const remoteRef = refs.find((r) => r.kind === 'remote' && r.name === target);
  if (!remoteRef) return done('new');
  return remoteRef.sha === local.sha ? done('upToDate') : done('unknown');
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
