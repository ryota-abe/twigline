import type { Operation, RpcError } from '../../../../shared/protocol';
import { useStore } from '../../store/store';
import { BranchDialog, CheckoutDialog, MergeDialog, RebaseDialog, RenameBranchDialog, ResetDialog, SetUpstreamDialog } from './BranchDialogs';
import { InteractiveRebaseDialog } from './InteractiveRebase';
import {
  ConfirmDialog,
  DiscardDialog,
  EditMessageDialog,
  ErrorDialog,
  IgnoreDialog,
  SettingsDialog,
  StashApplyDialog,
  StashBranchDialog,
  StashDialog,
  TagDeleteDialog,
  TagDialog,
  TagPushDialog,
} from './MiscDialogs';
import { FetchDialog, PullDialog, PushBranchesDialog, PushDialog } from './RemoteDialogs';

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const hasSnapshot = useStore((s) => !!s.snapshot);
  if (!dialog) return null;
  const p = dialog.props as Record<string, never>;
  // Do not show a dialog that refers to the repository until there is state
  if (!hasSnapshot && dialog.kind !== 'error' && dialog.kind !== 'confirm' && dialog.kind !== 'editMessage') return null;
  const key = JSON.stringify(dialog.props);
  switch (dialog.kind) {
    case 'pull':
      return <PullDialog key={key} {...p} />;
    case 'push':
      return <PushDialog key={key} {...p} />;
    case 'pushBranches':
      return <PushBranchesDialog key={key} />;
    case 'fetch':
      return <FetchDialog key={key} />;
    case 'branch':
      return <BranchDialog key={key} {...p} />;
    case 'checkout':
      return <CheckoutDialog key={key} {...p} />;
    case 'renameBranch':
      return <RenameBranchDialog key={key} name={p.name} />;
    case 'setUpstream':
      return <SetUpstreamDialog key={key} branch={p.branch} />;
    case 'merge':
      return <MergeDialog key={key} {...p} />;
    case 'rebase':
      return <RebaseDialog key={key} {...p} />;
    case 'reset':
      return <ResetDialog key={key} sha={p.sha} />;
    case 'tag':
      return <TagDialog key={key} {...p} />;
    case 'tagDelete':
      return <TagDeleteDialog key={key} name={p.name} />;
    case 'tagPush':
      return <TagPushDialog key={key} name={p.name} />;
    case 'stash':
      return <StashDialog key={key} />;
    case 'stashApply':
      return <StashApplyDialog key={key} index={p.index} />;
    case 'stashBranch':
      return <StashBranchDialog key={key} index={p.index} />;
    case 'discard':
      return <DiscardDialog key={key} {...p} />;
    case 'ignore':
      return <IgnoreDialog key={key} path={p.path} />;
    case 'confirm':
      return <ConfirmDialog key={key} title={p.title} message={p.message} okLabel={p.okLabel} danger={p.danger} detail={p.detail} />;
    case 'error':
      return <ErrorDialog key={key} error={p.error as unknown as RpcError} op={p.op as unknown as Operation | undefined} />;
    case 'editMessage':
      return <EditMessageDialog key={key} requestId={p.requestId} title={p.title} initial={p.initial} />;
    case 'settings':
      return <SettingsDialog key={key} />;
    case 'interactiveRebase':
      return <InteractiveRebaseDialog key={key} base={p.base ?? null} />;
  }
}
