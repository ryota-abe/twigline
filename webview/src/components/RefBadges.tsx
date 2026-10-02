import { useMemo } from 'react';
import type { RefInfo, RepoSnapshot, StashInfo } from '../../../shared/protocol';
import { useStore } from '../store/store';
import { cx } from '../util/format';
import { PrChip, prDone, prOf } from './PullRequest';
import { Icon } from './ui';

export interface RefsBySha {
  refs: Map<string, RefInfo[]>;
  stashes: Map<string, StashInfo>;
}

/** SHA -> the list of refs pointing at that commit (local branches, then remotes, then tags) */
export function useRefsBySha(snapshot: RepoSnapshot | null): RefsBySha {
  return useMemo(() => {
    const refs = new Map<string, RefInfo[]>();
    const stashes = new Map<string, StashInfo>();
    if (!snapshot) return { refs, stashes };
    const order = { head: 0, remote: 1, tag: 2 } as const;
    for (const r of snapshot.refs) {
      const list = refs.get(r.sha) ?? [];
      list.push(r);
      refs.set(r.sha, list);
    }
    for (const list of refs.values()) {
      list.sort((a, b) => order[a.kind] - order[b.kind] || Number(!!b.isHead) - Number(!!a.isHead) || a.name.localeCompare(b.name));
    }
    for (const s of snapshot.stashes) stashes.set(s.sha, s);
    return { refs, stashes };
  }, [snapshot]);
}

/**
 * Ref badges (local branches filled, remotes outlined, tags yellow).
 * For a branch with a PR, the PR mark is attached to the right of the badge. A PR on a local branch at the same commit is not repeated on the remote branch
 */
export function RefBadges({ refs, stash, detachedHead }: { refs?: RefInfo[]; stash?: StashInfo; detachedHead?: boolean }) {
  const prs = useStore((s) => s.pullRequests);
  if (!refs?.length && !stash && !detachedHead) return null;
  const onLocal = new Set((refs ?? []).filter((r) => r.kind === 'head').map((r) => prOf(prs, r)?.url));
  return (
    <span className="refs">
      {detachedHead && (
        <span className="ref head-detached" title="HEAD">
          <Icon name="target" />
          HEAD
        </span>
      )}
      {(refs ?? []).map((r) => {
        const pr = prOf(prs, r);
        const badge = (
          <span key={r.fullName} className={cx('ref', r.kind === 'head' ? 'local' : r.kind, r.isHead && 'is-head', prDone(pr) && 'pr-done')} title={r.fullName}>
            {r.kind === 'tag' ? <Icon name="tag" /> : r.kind === 'remote' ? <Icon name="cloud" /> : r.isHead ? <Icon name="target" /> : <Icon name="git-branch" />}
            {r.name}
          </span>
        );
        if (!pr || (r.kind === 'remote' && onLocal.has(pr.url))) return badge;
        return (
          <span key={r.fullName} className="ref-group">
            {badge}
            <PrChip pr={pr} refName={r.fullName} />
          </span>
        );
      })}
      {stash && (
        <span className="ref stash" title={stash.message}>
          <Icon name="archive" />
          {`stash@{${stash.index}}`}
        </span>
      )}
    </span>
  );
}
