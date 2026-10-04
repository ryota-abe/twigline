import type { PullRequestInfo } from '../../../../shared/protocol';
import { t } from '../../i18n';
import type { ResetMode, ResetStatus } from '../../util/resetStatus';
import { SummaryCard, SummaryHint, SummaryPr, type SummaryTone } from './SummaryCard';

// What a reset would do: the route (the branch at its commit -> the target commit), how many commits are taken off and
// brought on, where their changes go in the chosen mode, and what may be lost.

function stateLine(s: ResetStatus, mode: ResetMode): { icon: string; text: string } {
  switch (s.state) {
    case 'loading':
      return { icon: 'loading', text: t('summary.loading') };
    case 'unknown':
      return { icon: 'info', text: t('summary.unknown') };
    case 'same':
      if (s.nothing) return { icon: 'check', text: t('reset.state.nothing') };
      return mode === 'hard' ? { icon: 'discard', text: t('reset.state.sameHard', String(s.discarded)) } : { icon: 'remove', text: t('reset.state.sameMixed', String(s.staged)) };
    case 'back':
      return { icon: 'history', text: t(`reset.state.back.${mode}`, String(s.removed)) };
    case 'forward':
      return { icon: 'arrow-down', text: t('reset.state.forward', String(s.added)) };
    case 'sideways':
      return { icon: 'git-compare', text: t('reset.state.sideways', String(s.removed), String(s.added)) };
  }
}

export function ResetStatusCard({
  from,
  to,
  status,
  mode,
  found,
}: {
  from: string;
  to: string;
  status: ResetStatus;
  mode: ResetMode;
  /** PR of the current branch */
  found: { pr: PullRequestInfo; ref: string } | undefined;
}) {
  const { icon, text } = stateLine(status, mode);
  const orphaned = status.orphaned ?? 0;
  // soft / mixed keep the working tree as it is, so moving to other commits leaves their difference as changes
  const keepsTree = mode !== 'hard' && (status.state === 'forward' || status.state === 'sideways');
  const prOpen = found?.pr.state === 'open' || found?.pr.state === 'draft';
  const tone: SummaryTone =
    orphaned > 0 || status.pushedRemoved > 0 || (mode === 'hard' && status.discarded > 0)
      ? 'warn'
      : status.state === 'loading' || status.state === 'unknown'
        ? 'info'
        : 'ok';
  return (
    <SummaryCard tone={tone} from={from} to={to} ahead={status.removed} behind={status.added} icon={icon} text={text}>
      {keepsTree && <SummaryHint>{t('reset.keepsTree')}</SummaryHint>}
      {orphaned > 0 && <SummaryHint warn>{t('reset.orphaned', String(orphaned))}</SummaryHint>}
      {status.pushedRemoved > 0 && <SummaryHint warn>{t('reset.pushedRemoved', String(status.pushedRemoved))}</SummaryHint>}
      <SummaryPr found={found} prs={null} remote="" />
      {status.pushedRemoved > 0 && prOpen && <SummaryHint>{t('push.pr.forceNote', String(found!.pr.number))}</SummaryHint>}
    </SummaryCard>
  );
}
