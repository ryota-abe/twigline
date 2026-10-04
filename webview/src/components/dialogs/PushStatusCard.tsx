import type { PullRequestList, RefInfo } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { cx } from '../../util/format';
import { pullRequestFor, type PushStatus } from '../../util/pushStatus';
import { PrChip } from '../PullRequest';
import { Icon } from '../ui';

// What a push would do: the route (local -> remote branch), how it compares with the remote, and the pull request of the target branch.
// The comparison comes from the last fetch, so a hint says so.

const STATE_ICON: Record<PushStatus['state'], string> = {
  new: 'add',
  upToDate: 'check',
  ahead: 'arrow-up',
  behind: 'warning',
  diverged: 'warning',
  gone: 'info',
  unknown: 'info',
};

function stateText(s: PushStatus): string {
  switch (s.state) {
    case 'ahead':
      return t('push.state.ahead', String(s.ahead));
    case 'behind':
      return t('push.state.behind', String(s.behind));
    case 'diverged':
      return t('push.state.diverged', String(s.ahead), String(s.behind));
    default:
      return t(`push.state.${s.state}`);
  }
}

export function PushStatusCard({
  local,
  remote,
  remoteName,
  status,
  force,
  prs,
}: {
  local: RefInfo;
  remote: string;
  remoteName: string;
  status: PushStatus;
  force: boolean;
  prs: PullRequestList | null;
}) {
  const compared = status.state === 'ahead' || status.state === 'behind' || status.state === 'diverged' || status.state === 'upToDate';
  const found = pullRequestFor(prs, local, remote, remoteName);
  const hosted = !!prs?.hostedRemotes?.includes(remote);
  const prDone = found?.pr.state === 'merged' || found?.pr.state === 'closed';

  return (
    <div className={cx('push-card', status.forceRequired ? 'warn' : status.state === 'unknown' || status.state === 'gone' ? 'info' : 'ok')}>
      <div className="push-route">
        <span className="mono">{local.name}</span>
        <Icon name="arrow-right" />
        <span className="mono">{`${remote}/${remoteName}`}</span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="push-counts" aria-hidden="true">
            {`↑${status.ahead} ↓${status.behind}`}
          </span>
        )}
      </div>
      <div className="push-state">
        <Icon name={STATE_ICON[status.state]} />
        <span>{stateText(status)}</span>
      </div>
      {compared && <div className="push-hint">{t('push.staleHint')}</div>}
      {found ? (
        <div className="push-pr">
          <PrChip pr={found.pr} refName={found.ref} />
          <span className="push-pr-title">{found.pr.title}</span>
          <span className="push-pr-branches mono">{`${found.pr.baseRef} ← ${found.pr.headRef}`}</span>
        </div>
      ) : hosted && prs?.status === 'ok' ? (
        <div className="push-pr muted">
          <Icon name="git-pull-request" />
          <span>{t('push.pr.none')}</span>
        </div>
      ) : hosted && (prs?.status === 'signIn' || prs?.status === 'error') ? (
        <div className="push-pr muted" title={prs.message}>
          <Icon name="warning" />
          <span>{t('push.pr.unknown')}</span>
        </div>
      ) : null}
      {found && status.state !== 'upToDate' && (
        <div className={cx('push-hint', prDone && 'warn')}>
          {prDone ? (
            <>
              <Icon name="warning" />
              {t(found.pr.state === 'merged' ? 'push.pr.merged' : 'push.pr.closed', String(found.pr.number))}
            </>
          ) : force ? (
            t('push.pr.forceNote', String(found.pr.number))
          ) : (
            t('push.pr.reflect', String(found.pr.number))
          )}
        </div>
      )}
    </div>
  );
}
