import { t } from '../i18n';
import { confirm, runOp } from '../store/actions';
import { useStore } from '../store/store';
import { shortSha } from '../util/format';
import { Button, Icon } from './ui';

// Banner at the top for an operation in progress. During merge, rebase or cherry-pick, continue and abort can always be pressed

export function SequenceBanner() {
  const seq = useStore((s) => s.snapshot?.sequence);
  const head = useStore((s) => s.snapshot?.head);
  const conflicts = useStore((s) => s.status?.conflicted.length ?? 0);
  const commitMsg = useStore((s) => s.commitMsg);
  if (!seq) return null;

  let text: string;
  switch (seq.kind) {
    case 'merge':
      text = t('banner.merge', seq.incomingName ?? shortSha(seq.incoming ?? ''), head?.branch ?? 'HEAD', String(conflicts));
      break;
    case 'rebase':
      text = seq.stoppedForEdit
        ? t('banner.rebaseEdit', String(seq.step ?? '?'), String(seq.total ?? '?'))
        : t('banner.rebase', seq.branch ?? 'HEAD', String(seq.step ?? '?'), String(seq.total ?? '?'), String(conflicts));
      break;
    case 'cherry-pick':
      text = t('banner.cherryPick', shortSha(seq.incoming ?? ''), String(conflicts));
      break;
    case 'revert':
      text = t('banner.revert', shortSha(seq.incoming ?? ''), String(conflicts));
      break;
  }

  const abort = async () => {
    const ok = await confirm({ title: t('banner.abortTitle'), message: t('banner.abortMessage'), okLabel: t('banner.abort'), danger: true });
    if (ok) await runOp({ kind: 'sequence/control', action: 'abort' });
  };

  return (
    <div className="banner" role="status">
      <Icon name="warning" />
      <b>{text}</b>
      <span className="spacer" />
      <Button small onClick={() => void abort()}>
        {seq.kind === 'merge' ? t('banner.abortMergeButton') : t('banner.abortButton')}
      </Button>
      {seq.kind !== 'merge' && (
        <Button small onClick={() => void runOp({ kind: 'sequence/control', action: 'skip' })}>
          {t('banner.skip')}
        </Button>
      )}
      <Button
        small
        primary
        disabled={conflicts > 0}
        title={conflicts > 0 ? t('banner.resolveFirst') : undefined}
        onClick={() => void runOp({ kind: 'sequence/control', action: 'continue', message: seq.kind === 'merge' ? commitMsg.trim() || undefined : undefined })}
      >
        {seq.kind === 'merge' ? t('banner.commitMerge') : t('banner.continue')}
      </Button>
    </div>
  );
}
