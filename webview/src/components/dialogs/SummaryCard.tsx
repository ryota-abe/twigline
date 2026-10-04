import type { ReactNode } from 'react';
import type { PullRequestInfo, PullRequestList } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { cx } from '../../util/format';
import { PrChip } from '../PullRequest';
import { Icon } from '../ui';

// What an operation would do, shown at the top of its dialog: the route (from -> to), how the two sides compare,
// one line saying what happens, then hints and the pull request involved. The tone colors the left edge:
// ok (it goes through), warn (something needs a decision), info (not known).

export type SummaryTone = 'ok' | 'warn' | 'info';

export function SummaryCard({
  tone,
  from,
  to,
  ahead,
  behind,
  icon,
  text,
  children,
}: {
  tone: SummaryTone;
  from: string;
  to: string;
  /** Commits only on the local side / only on the remote side (↑ / ↓). Shown when either is above 0 */
  ahead?: number;
  behind?: number;
  icon: string;
  text: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cx('summary-card', tone)}>
      <div className="summary-route">
        <span className="mono">{from}</span>
        <Icon name="arrow-right" />
        <span className="mono">{to}</span>
        {(!!ahead || !!behind) && (
          <span className="summary-counts" aria-hidden="true">
            {`↑${ahead ?? 0} ↓${behind ?? 0}`}
          </span>
        )}
      </div>
      <div className="summary-state">
        <Icon name={icon} spin={icon === 'loading'} />
        <span>{text}</span>
      </div>
      {children}
    </div>
  );
}

/** Secondary line of the card. warn puts a warning icon in front */
export function SummaryHint({ warn, children }: { warn?: boolean; children: ReactNode }) {
  return (
    <div className={cx('summary-hint', warn && 'warn')}>
      {warn && <Icon name="warning" />}
      <span>{children}</span>
    </div>
  );
}

/** List of paths under a hint, cut off after a few */
export function SummaryFiles({ paths, max = 5 }: { paths: string[]; max?: number }) {
  if (paths.length === 0) return null;
  return (
    <ul className="summary-files">
      {paths.slice(0, max).map((p) => (
        <li key={p} className="mono">
          {p}
        </li>
      ))}
      {paths.length > max && <li className="dim">{t('summary.moreFiles', String(paths.length - max))}</li>}
    </ul>
  );
}

/**
 * Pull request row: the PR when there is one; for a remote PRs can be read from, "no PR" or "could not check".
 * Nothing for other remotes
 */
export function SummaryPr({ found, prs, remote }: { found: { pr: PullRequestInfo; ref: string } | undefined; prs: PullRequestList | null; remote: string }) {
  const hosted = !!prs?.hostedRemotes?.includes(remote);
  if (found) {
    return (
      <div className="summary-pr">
        <PrChip pr={found.pr} refName={found.ref} />
        <span className="summary-pr-title">{found.pr.title}</span>
        <span className="summary-pr-branches mono">{`${found.pr.baseRef} ← ${found.pr.headRef}`}</span>
      </div>
    );
  }
  if (hosted && prs?.status === 'ok') {
    return (
      <div className="summary-pr muted">
        <Icon name="git-pull-request" />
        <span>{t('summary.pr.none')}</span>
      </div>
    );
  }
  if (hosted && (prs?.status === 'signIn' || prs?.status === 'error')) {
    return (
      <div className="summary-pr muted" title={prs.message}>
        <Icon name="warning" />
        <span>{t('summary.pr.unknown')}</span>
      </div>
    );
  }
  return null;
}
