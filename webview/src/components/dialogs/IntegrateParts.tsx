import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { openDialog } from '../../store/actions';
import type { IntegrateStatus } from '../../util/integrate';
import { Button, Checkbox } from '../ui';
import { Requirement, RequirementActions } from './Dialog';
import { SummaryFiles, SummaryHint } from './SummaryCard';

// Pieces shared by the dialogs that bring commits into the current branch (pull, merge, rebase)

/** IntegrateStatus, or one that adds states of its own (PullStatus) */
type Status = Omit<IntegrateStatus, 'state'> & { state: string };

/** The --autostash option */
export function AutostashCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return <Checkbox checked={checked} onChange={onChange} label={t('summary.autostash')} />;
}

/** Conflicts to show: only when both sides have commits and the operation merges them (not a fast-forward-only pull) */
function shownConflicts(status: Status, merges: boolean): string[] | null | undefined {
  return merges && (status.state === 'diverged' || status.state === 'unrelated') ? status.conflicts : undefined;
}

/** Card lines for predicted conflicts and untracked files in the way */
export function IntegrateHints({ status, rebase, merges = true }: { status: Status; rebase: boolean; merges?: boolean }) {
  const conflicts = shownConflicts(status, merges);
  const lines: ReactNode[] = [];
  if (conflicts && conflicts.length > 0) {
    lines.push(
      <SummaryHint key="conflicts" warn>
        {t(rebase ? 'summary.conflicts.rebase' : 'summary.conflicts', String(conflicts.length))}
      </SummaryHint>,
      <SummaryFiles key="conflict-files" paths={conflicts} />,
    );
  } else if (conflicts) {
    lines.push(<SummaryHint key="no-conflicts">{t('summary.noConflicts')}</SummaryHint>);
  }
  if (status.untrackedOverlap.length > 0) {
    lines.push(
      <SummaryHint key="untracked" warn>
        {t('summary.untrackedOverlap')}
      </SummaryHint>,
      <SummaryFiles key="untracked-files" paths={status.untrackedOverlap} />,
    );
  }
  return <>{lines}</>;
}

/** The hints above put the card in the warning tone */
export function integrateWarns(status: Status, merges = true): boolean {
  return !!shownConflicts(status, merges)?.length || status.untrackedOverlap.length > 0;
}

/**
 * Local changes must be stashed first: any change for a rebase, the files the incoming commits change for a merge.
 * Settled by --autostash when the git in use has it, or by stashing in the stash dialog
 */
export function StashRequirement({
  status,
  rebase,
  autostash,
  onAutostash,
}: {
  status: Status;
  rebase: boolean;
  /** undefined when --autostash cannot be used */
  autostash: boolean | undefined;
  onAutostash: (v: boolean) => void;
}) {
  return (
    <Requirement
      title={t('summary.need.stash')}
      detail={rebase ? t('summary.need.stashRebase', String(status.dirty.length)) : t('summary.need.stashMerge', String(status.overlap.length))}
    >
      {!rebase && <SummaryFiles paths={status.overlap} />}
      {autostash !== undefined && <AutostashCheckbox checked={autostash} onChange={onAutostash} />}
      <RequirementActions>
        <Button small onClick={() => openDialog('stash')}>
          {t('summary.need.openStash')}
        </Button>
      </RequirementActions>
    </Requirement>
  );
}
