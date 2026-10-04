import type { PullRequestInfo, PullRequestList } from '../../../../shared/protocol';
import { t } from '../../i18n';
import type { PullMode, PullStatus } from '../../util/pullStatus';
import { IntegrateHints, integrateWarns } from './IntegrateParts';
import { SummaryCard, SummaryHint, SummaryPr, type SummaryTone } from './SummaryCard';

// What a pull would do: the route (remote branch -> local branch), how they compare as of the last fetch,
// what happens in the chosen mode, predicted conflicts, and the pull request of the remote branch.

function stateLine(s: PullStatus, mode: PullMode, target: string): { icon: string; text: string } {
  switch (s.state) {
    case 'notFetched':
      return { icon: 'cloud-download', text: t('pull.state.notFetched', target) };
    case 'loading':
      return { icon: 'loading', text: t('pull.state.loading') };
    case 'unknown':
      return { icon: 'info', text: t('pull.state.unknown') };
    case 'upToDate':
      return { icon: 'check', text: t('pull.state.upToDate') };
    case 'fastForward':
      return { icon: 'arrow-down', text: t('pull.state.fastForward', String(s.behind)) };
    case 'unrelated':
      return { icon: 'warning', text: t('pull.state.unrelated') };
    case 'diverged':
      if (mode === 'merge') return { icon: 'git-merge', text: t('pull.state.merge', String(s.behind), String(s.ahead)) };
      if (mode === 'rebase') return { icon: 'arrow-down', text: t('pull.state.rebase', String(s.behind), String(s.ahead)) };
      return { icon: 'warning', text: t('pull.state.diverged', String(s.ahead), String(s.behind)) };
  }
}

export function PullStatusCard({
  from,
  into,
  remote,
  status,
  mode,
  blocked,
  intoOther,
  found,
  prs,
}: {
  /** remote/branch */
  from: string;
  into: string;
  remote: string;
  status: PullStatus;
  mode: PullMode;
  /** Something must be settled before the pull (shown as a Requirement under the card) */
  blocked: boolean;
  /** The branch is not checked out, so the pull is a fast-forward by fetch */
  intoOther: boolean;
  found: { pr: PullRequestInfo; ref: string } | undefined;
  prs: PullRequestList | null;
}) {
  const { icon, text } = stateLine(status, mode, from);
  const compared = status.state === 'upToDate' || status.state === 'fastForward' || status.state === 'diverged' || status.state === 'unrelated';
  const rewrites = status.state === 'diverged' && mode === 'rebase' && status.rewritesPushed;
  const tone: SummaryTone =
    blocked || rewrites || integrateWarns(status, mode !== 'ffOnly')
      ? 'warn'
      : status.state === 'notFetched' || status.state === 'loading' || status.state === 'unknown'
        ? 'info'
        : 'ok';

  return (
    <SummaryCard tone={tone} from={from} to={into} ahead={status.ahead} behind={status.behind} icon={icon} text={text}>
      {compared && <SummaryHint>{t('pull.staleHint')}</SummaryHint>}
      {intoOther && <SummaryHint>{t('pull.intoOther')}</SummaryHint>}
      <IntegrateHints status={status} rebase={mode === 'rebase'} merges={mode !== 'ffOnly'} />
      {rewrites && <SummaryHint warn>{t('summary.rewritesPushed')}</SummaryHint>}
      <SummaryPr found={found} prs={prs} remote={remote} />
    </SummaryCard>
  );
}
