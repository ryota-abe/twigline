import type { RefInfo } from '../../../shared/protocol';

// Whether deleting a local branch is safe, from its upstream counts and how many of its commits HEAD lacks.
// git branch -d checks the branch against its upstream when it has one (even if HEAD has merged it), otherwise against HEAD.

export interface DeleteInfo {
  /** Commits HEAD does not have; undefined until known */
  unmerged?: number;
  /** Commits its upstream does not have; undefined without an upstream (none, or deleted on the remote) */
  unpushed?: number;
  /** git branch -d refuses it, so it needs -D */
  forceRequired: boolean;
  /**
   * Commits that may be on no other branch or remote once it is deleted: not in HEAD and not pushed.
   * An estimate (other local branches are not looked at), so it is shown as "may be lost"
   */
  atRisk: number;
}

export function deleteInfo(ref: RefInfo, unmerged: number | undefined): DeleteInfo {
  const tracked = !!ref.upstream && !ref.gone;
  const unpushed = tracked ? (ref.ahead ?? 0) : undefined;
  const forceRequired = unpushed !== undefined ? unpushed > 0 : (unmerged ?? 0) > 0;
  const atRisk = unmerged === undefined ? 0 : unpushed !== undefined ? Math.min(unmerged, unpushed) : unmerged;
  return { unmerged, unpushed, forceRequired, atRisk };
}

/** Merged into HEAD and deletable without force: what "Select merged" picks */
export function safeToDelete(info: DeleteInfo): boolean {
  return info.unmerged === 0 && !info.forceRequired;
}
