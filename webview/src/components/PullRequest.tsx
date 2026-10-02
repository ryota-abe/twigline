import type { MouseEvent } from 'react';
import type { PullRequestInfo, PullRequestList, PullRequestState, RefInfo } from '../../../shared/protocol';
import { t } from '../i18n';
import { loadPullRequests, uiAction } from '../store/actions';
import { useStore } from '../store/store';
import { cx } from '../util/format';
import { Icon } from './ui';

// Mark for the pull request (GitHub, Bitbucket Cloud) linked to a branch. The state is also told apart by icon, not color alone (same colors as GitHub):
// under review is a green git-pull-request, draft a gray git-pull-request-draft,
// merged a purple git-merge, and closed without merging (including declined or superseded on Bitbucket) a red git-pull-request-closed.
// Pressing it opens the PR in the browser. Branches whose PR is merged or closed have a dimmed name, as ones that are fine to clean up (pr-done).

const ICONS: Record<PullRequestState, string> = {
  open: 'git-pull-request',
  draft: 'git-pull-request-draft',
  merged: 'git-merge',
  closed: 'git-pull-request-closed',
};

export function prOf(list: PullRequestList | null, ref: RefInfo): PullRequestInfo | undefined {
  return ref.kind === 'tag' ? undefined : list?.byRef[ref.fullName];
}

/** The PR is finished (merged, or closed without merging) */
export function prDone(pr: PullRequestInfo | undefined): boolean {
  return pr?.state === 'merged' || pr?.state === 'closed';
}

/** Context used by the when clauses of the right-click menu (open the PR; create a PR unless one is under review) */
export function prContext(pr: PullRequestInfo | undefined): { twiglinePr: boolean; twiglinePrOpen: boolean } {
  return { twiglinePr: !!pr, twiglinePrOpen: pr?.state === 'open' || pr?.state === 'draft' };
}

export function PrChip({ pr, refName }: { pr: PullRequestInfo; refName: string }) {
  const state = t(pr.closedAs ? `pr.${pr.closedAs}` : `pr.${pr.state}`);
  // A left click is not passed on to row selection, moving to the branch or double-click checkout (a right click selects like the row does)
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <button
      type="button"
      className={cx('pr-chip', pr.state)}
      title={t('pr.tooltip', String(pr.number), pr.title, state, pr.baseRef, pr.headRef)}
      aria-label={`#${pr.number} ${state}`}
      onMouseDown={(e) => e.button === 0 && stop(e)}
      onDoubleClick={stop}
      onClick={(e) => {
        e.stopPropagation();
        uiAction({ kind: 'openPullRequest', ref: refName });
      }}
    >
      <Icon name={ICONS[pr.state]} />
      {`#${pr.number}`}
    </button>
  );
}

/** Notice for when PRs cannot be read (sign-in needed, failed). Shown at the end of the branch list in the sidebar */
export function PrNotice() {
  const prs = useStore((s) => s.pullRequests);
  if (prs?.status === 'signIn') {
    const provider = prs.provider ?? 'github';
    const hint = t(`pr.signInHint.${provider}`);
    return (
      <div
        className="side-item side-note"
        role="treeitem"
        title={prs.message ? `${hint}\n${prs.message}` : hint}
        onClick={() => uiAction({ kind: 'pullRequestSignIn', provider })}
      >
        <Icon name={provider === 'github' ? 'github' : 'key'} />
        <span className="label">{t(`pr.signIn.${provider}`)}</span>
      </div>
    );
  }
  if (prs?.status === 'error') {
    return (
      <div className="side-item side-note" role="treeitem" title={prs.message} onClick={() => void loadPullRequests(true)}>
        <Icon name="warning" />
        <span className="label">{t('pr.error')}</span>
      </div>
    );
  }
  return null;
}
