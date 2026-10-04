import type { PullRequestList, RefInfo } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { pullRequestFor, type PushStatus } from '../../util/pushStatus';
import { SummaryCard, SummaryHint, SummaryPr } from './SummaryCard';

// What a push would do: the route (local -> remote branch), how it compares with the remote, and the pull request of the target branch.
// The comparison comes from the last fetch, so a hint says so.

export const STATE_ICON: Record<PushStatus['state'], string> = {
  new: 'add',
  upToDate: 'check',
  ahead: 'arrow-up',
  behind: 'warning',
  diverged: 'warning',
  gone: 'info',
  unknown: 'info',
};

export function stateText(s: PushStatus): string {
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
  const prDone = found?.pr.state === 'merged' || found?.pr.state === 'closed';

  return (
    <SummaryCard
      tone={status.forceRequired ? 'warn' : status.state === 'unknown' || status.state === 'gone' ? 'info' : 'ok'}
      from={local.name}
      to={`${remote}/${remoteName}`}
      ahead={status.ahead}
      behind={status.behind}
      icon={STATE_ICON[status.state]}
      text={stateText(status)}
    >
      {compared && <SummaryHint>{t('summary.staleHint')}</SummaryHint>}
      <SummaryPr found={found} prs={prs} remote={remote} />
      {found && status.state !== 'upToDate' && (
        <SummaryHint warn={prDone}>
          {prDone
            ? t(found.pr.state === 'merged' ? 'push.pr.merged' : 'push.pr.closed', String(found.pr.number))
            : force
              ? t('push.pr.forceNote', String(found.pr.number))
              : t('push.pr.reflect', String(found.pr.number))}
        </SummaryHint>
      )}
    </SummaryCard>
  );
}
