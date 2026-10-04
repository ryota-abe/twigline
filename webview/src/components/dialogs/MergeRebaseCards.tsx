import type { PullRequestInfo } from '../../../../shared/protocol';
import { t } from '../../i18n';
import type { IntegrateStatus, MergeMode } from '../../util/integrate';
import { IntegrateHints, integrateWarns } from './IntegrateParts';
import { SummaryCard, SummaryHint, SummaryPr, type SummaryTone } from './SummaryCard';

// What a merge or a rebase would do: the route, how the two sides compare, what happens, predicted conflicts,
// and the pull request involved (of the merged branch / of the rebased branch).

type Found = { pr: PullRequestInfo; ref: string } | undefined;

function common(s: IntegrateStatus): { icon: string; text: string } | undefined {
  if (s.state === 'loading') return { icon: 'loading', text: t('summary.loading') };
  if (s.state === 'unknown') return { icon: 'info', text: t('summary.unknown') };
  return undefined;
}

function tone(s: IntegrateStatus, warn: boolean): SummaryTone {
  return warn || integrateWarns(s) ? 'warn' : s.state === 'loading' || s.state === 'unknown' ? 'info' : 'ok';
}

function mergeLine(s: IntegrateStatus, mode: MergeMode, source: string): { icon: string; text: string } {
  const c = common(s);
  if (c) return c;
  switch (s.state) {
    case 'upToDate':
      return { icon: 'check', text: t('merge.state.upToDate', source) };
    case 'unrelated':
      return { icon: 'warning', text: t('merge.state.unrelated') };
    default:
      if (mode === 'squash') return { icon: 'fold', text: t('merge.state.squash', String(s.behind)) };
      if (s.state === 'diverged') return { icon: 'git-merge', text: t('merge.state.merge', String(s.behind), String(s.ahead)) };
      return mode === 'noFf' ? { icon: 'git-merge', text: t('merge.state.commit', String(s.behind)) } : { icon: 'arrow-down', text: t('merge.state.fastForward', String(s.behind)) };
  }
}

export function MergeStatusCard({
  source,
  into,
  status,
  mode,
  commit,
  blocked,
  found,
}: {
  source: string;
  into: string;
  status: IntegrateStatus;
  mode: MergeMode;
  /** Commit the merge right away (off: --no-commit) */
  commit: boolean;
  blocked: boolean;
  /** PR of the merged branch */
  found: Found;
}) {
  const { icon, text } = mergeLine(status, mode, source);
  const merges = status.state === 'fastForward' || status.state === 'diverged';
  // --no-commit cannot stop a fast-forward
  const noCommitIgnored = merges && !commit && mode === 'auto' && status.state === 'fastForward';
  return (
    <SummaryCard tone={tone(status, blocked || noCommitIgnored)} from={source} to={into} ahead={status.ahead} behind={status.behind} icon={icon} text={text}>
      <IntegrateHints status={status} rebase={false} />
      {merges && !commit && mode !== 'squash' && (noCommitIgnored ? <SummaryHint warn>{t('merge.noCommitFf')}</SummaryHint> : <SummaryHint>{t('merge.noCommitHint')}</SummaryHint>)}
      <SummaryPr found={found} prs={null} remote="" />
    </SummaryCard>
  );
}

function rebaseLine(s: IntegrateStatus, onto: string): { icon: string; text: string } {
  const c = common(s);
  if (c) return c;
  switch (s.state) {
    case 'upToDate':
      return { icon: 'check', text: t('rebase.state.upToDate', onto) };
    case 'fastForward':
      return { icon: 'arrow-down', text: t('rebase.state.fastForward', onto, String(s.behind)) };
    case 'unrelated':
      return { icon: 'warning', text: t('rebase.state.unrelated', String(s.ahead), onto) };
    default:
      return { icon: 'git-commit', text: t('rebase.state.diverged', String(s.ahead), onto, String(s.behind)) };
  }
}

export function RebaseStatusCard({
  branch,
  onto,
  status,
  blocked,
  found,
}: {
  branch: string;
  onto: string;
  status: IntegrateStatus;
  blocked: boolean;
  /** PR of the rebased branch */
  found: Found;
}) {
  const { icon, text } = rebaseLine(status, onto);
  const rewrites = (status.state === 'diverged' || status.state === 'unrelated') && status.rewritesPushed;
  const prOpen = found?.pr.state === 'open' || found?.pr.state === 'draft';
  return (
    <SummaryCard tone={tone(status, blocked || rewrites || status.state === 'unrelated')} from={branch} to={onto} ahead={status.ahead} behind={status.behind} icon={icon} text={text}>
      <IntegrateHints status={status} rebase />
      {rewrites && <SummaryHint warn>{t('summary.rewritesPushed')}</SummaryHint>}
      <SummaryPr found={found} prs={null} remote="" />
      {rewrites && prOpen && <SummaryHint>{t('push.pr.forceNote', String(found!.pr.number))}</SummaryHint>}
    </SummaryCard>
  );
}
