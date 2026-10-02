import { t } from './i18n';
import {
  confirm,
  copyText,
  getRpc,
  loadDetail,
  openDialog,
  refreshAll,
  rowIndexOf,
  runOp,
  selectRow,
  setQuery,
  setView,
  stagePaths,
  toast,
  uiAction,
} from './store/actions';
import { get, set } from './store/store';
import { UNCOMMITTED, shortSha } from './util/format';

// Context menus. Turns commands from right-click (webview/context) and keybindings into actions inside the webview.
// Labels are static, so the name of the target is shown in the confirmation dialog instead.

type Ctx = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** If the right-clicked row is part of a multiple selection, everything selected; otherwise only that row (oldest first) */
function targetShas(sha: string): string[] {
  const s = get();
  const sel = s.selected.filter((x) => x !== UNCOMMITTED);
  const list = sel.includes(sha) && sel.length > 1 ? sel : [sha];
  return [...list].sort((a, b) => rowIndexOf(b) - rowIndexOf(a));
}

/** Right-click on a file: everything selected if the file is among the selected ones */
function targetPaths(path: string, section: string): string[] {
  const s = get();
  const group = section === 'file.staged' ? 'staged' : section === 'file.conflicted' ? 'conflicted' : 'unstaged';
  if (s.fsSelected?.group === group && s.fsSelected.paths.includes(path)) return s.fsSelected.paths;
  return [path];
}

function commitTarget(ctx: Ctx) {
  const sha = str(ctx.sha)!;
  const compareTo = str(ctx.compareTo);
  return compareTo ? { kind: 'range' as const, from: compareTo, to: sha } : { kind: 'commit' as const, sha, parent: typeof ctx.parent === 'number' ? ctx.parent : undefined };
}

export async function handleCommand(command: string, ctx: Ctx): Promise<void> {
  const sha = str(ctx.sha);
  const ref = str(ctx.ref);
  const path = str(ctx.path);
  const section = str(ctx.section) ?? '';
  const snapshot = get().snapshot;

  switch (command) {
    case 'twigline.refresh':
      await refreshAll();
      return;

    // ---- Editor title bar (editor/title) ----
    // ---- Current branch ----
    case 'twigline.panel.pull':
      openDialog('pull');
      return;
    case 'twigline.panel.push':
      openDialog('push');
      return;
    case 'twigline.panel.merge':
      openDialog('merge');
      return;
    case 'twigline.panel.rebase':
      openDialog('rebase');
      return;
    // ---- Working tree ----
    case 'twigline.panel.stash':
      openDialog('stash');
      return;
    case 'twigline.panel.discard':
      openDialog('discard');
      return;
    // ---- Whole repository. The start point defaults to HEAD and is chosen in the dialog (the commit selected in history is never used silently) ----
    case 'twigline.panel.fetch':
      openDialog('fetch');
      return;
    case 'twigline.panel.pushBranches':
      openDialog('pushBranches');
      return;
    case 'twigline.panel.branch':
      openDialog('branch');
      return;
    case 'twigline.panel.tag':
      openDialog('tag');
      return;
    case 'twigline.panel.settings':
      openDialog('settings');
      return;

    // ---- commit ----
    case 'twigline.commit.checkout':
      if (sha) openDialog('checkout', { sha });
      return;
    case 'twigline.commit.createBranch':
      openDialog('branch', { tab: 'new', start: sha });
      return;
    case 'twigline.commit.createTag':
      openDialog('tag', { sha });
      return;
    case 'twigline.commit.merge':
      openDialog('merge', { ref: preferBranchName(sha) });
      return;
    case 'twigline.commit.rebase':
      openDialog('rebase', { onto: preferBranchName(sha) });
      return;
    case 'twigline.commit.cherryPick': {
      if (!sha) return;
      const shas = targetShas(sha);
      const ok = await confirm({
        title: t('cmd.cherryPickTitle'),
        message: t('cmd.cherryPick', String(shas.length), snapshot?.head.branch ?? 'HEAD'),
        detail: shas.map((s) => `${shortSha(s)} ${subjectOf(s)}`).join('\n'),
        okLabel: t('cmd.cherryPickOk'),
      });
      if (ok) await runOp({ kind: 'cherry-pick', shas, noCommit: false }, { success: t('cmd.cherryPickDone') });
      return;
    }
    case 'twigline.commit.revert': {
      if (!sha) return;
      const ok = await confirm({ title: t('cmd.revertTitle'), message: t('cmd.revert', `${shortSha(sha)} ${subjectOf(sha)}`), okLabel: t('cmd.revertOk') });
      if (ok) await runOp({ kind: 'revert', sha }, { success: t('cmd.revertDone') });
      return;
    }
    case 'twigline.commit.reset':
      if (sha) openDialog('reset', { sha });
      return;
    case 'twigline.commit.interactiveRebase':
      if (sha) openDialog('interactiveRebase', { base: sha });
      return;
    case 'twigline.commit.copySha':
      if (sha) copyText(targetShas(sha).reverse().join('\n'));
      return;
    case 'twigline.commit.copyMessage':
      if (sha) {
        const d = await getRpc().request('commit/detail', { repo: get().boot.repo, sha });
        copyText(d.message);
      }
      return;
    case 'twigline.commit.createPatch':
      if (sha) uiAction({ kind: 'createPatch', shas: targetShas(sha) });
      return;
    case 'twigline.commit.customAction':
      uiAction({ kind: 'customAction', sha });
      return;

    // ---- branch.local ----
    case 'twigline.branch.checkout':
      if (ref) await runOp({ kind: 'checkout', ref }, { success: t('cmd.checkedOut', ref) });
      return;
    case 'twigline.branch.createBranch':
    case 'twigline.remoteBranch.createBranch':
    case 'twigline.tag.createBranch':
      openDialog('branch', { tab: 'new', start: ref });
      return;
    case 'twigline.branch.merge':
      openDialog('merge', { ref });
      return;
    case 'twigline.branch.rebase':
      openDialog('rebase', { onto: ref });
      return;
    case 'twigline.branch.pull': {
      const r = snapshot?.refs.find((x) => x.kind === 'head' && x.name === ref);
      const remote = r?.upstream ? snapshot?.remotes.find((x) => r.upstream!.startsWith(x.name + '/'))?.name : undefined;
      openDialog('pull', { remote, branch: remote && r?.upstream ? r.upstream.slice(remote.length + 1) : ref, into: ref });
      return;
    }
    case 'twigline.branch.push':
      openDialog('push', { branch: ref });
      return;
    case 'twigline.branch.setUpstream':
      if (ref) openDialog('setUpstream', { branch: ref });
      return;
    case 'twigline.branch.compare':
    case 'twigline.remoteBranch.compare':
      compareWithHead(ref);
      return;
    case 'twigline.branch.rename':
      if (ref) openDialog('renameBranch', { name: ref });
      return;
    case 'twigline.branch.delete':
      openDialog('branch', { tab: 'delete', names: ref ? [ref] : [] });
      return;
    case 'twigline.branch.createPullRequest':
      if (ref) uiAction({ kind: 'createPullRequest', branch: ref });
      return;
    case 'twigline.branch.openPullRequest':
    case 'twigline.remoteBranch.openPullRequest': {
      const kind = command === 'twigline.branch.openPullRequest' ? 'head' : 'remote';
      const target = snapshot?.refs.find((r) => r.kind === kind && r.name === ref);
      if (target) uiAction({ kind: 'openPullRequest', ref: target.fullName });
      return;
    }

    // ---- branch.remote ----
    case 'twigline.remoteBranch.checkout':
      openDialog('checkout', { remoteRef: ref, remote: str(ctx.remote) });
      return;
    case 'twigline.remoteBranch.merge':
      openDialog('merge', { ref });
      return;
    case 'twigline.remoteBranch.delete': {
      const remote = str(ctx.remote) ?? ref?.split('/')[0];
      if (!ref || !remote) return;
      const branch = ref.slice(remote.length + 1);
      const ok = await confirm({ title: t('cmd.deleteRemoteBranchTitle'), message: t('cmd.deleteRemoteBranch', ref), okLabel: t('delete'), danger: true });
      if (ok) await runOp({ kind: 'remoteBranch/delete', remote, branch }, { success: t('cmd.deleted', ref) });
      return;
    }

    // ---- tag ----
    case 'twigline.tag.checkout':
      if (ref) await runOp({ kind: 'checkout', ref, detach: true });
      return;
    case 'twigline.tag.showDetails': {
      const target = snapshot?.refs.find((r) => r.kind === 'tag' && r.name === ref)?.sha;
      if (target) {
        setView('history');
        selectRow(target, {});
      }
      return;
    }
    case 'twigline.tag.push':
      if (ref) openDialog('tagPush', { name: ref });
      return;
    case 'twigline.tag.delete':
      if (ref) openDialog('tagDelete', { name: ref });
      return;

    // ---- stash ----
    case 'twigline.stash.apply':
      if (typeof ctx.index === 'number') openDialog('stashApply', { index: ctx.index });
      return;
    case 'twigline.stash.pop':
      if (typeof ctx.index === 'number') await runOp({ kind: 'stash/apply', index: ctx.index, drop: true, restoreIndex: false });
      return;
    case 'twigline.stash.showDiff':
      if (sha) {
        setView('history');
        selectRow(sha, {});
      }
      return;
    case 'twigline.stash.createBranch':
      if (typeof ctx.index === 'number') openDialog('stashBranch', { index: ctx.index });
      return;
    case 'twigline.stash.drop': {
      if (typeof ctx.index !== 'number') return;
      const st = snapshot?.stashes.find((s) => s.index === ctx.index);
      const ok = await confirm({
        title: t('cmd.dropStashTitle'),
        message: t('cmd.dropStash', `stash@{${ctx.index}}: ${st?.message ?? ''}`),
        okLabel: t('delete'),
        danger: true,
      });
      if (ok) await runOp({ kind: 'stash/drop', index: ctx.index });
      return;
    }

    // ---- files ----
    case 'twigline.file.stage':
      if (path) await stagePaths(targetPaths(path, section), 'stage');
      return;
    case 'twigline.file.unstage':
      if (path) await stagePaths(targetPaths(path, section), 'unstage');
      return;
    case 'twigline.file.discard':
      if (path) openDialog('discard', { paths: targetPaths(path, section) });
      return;
    case 'twigline.file.ignore':
      if (path) openDialog('ignore', { path });
      return;
    case 'twigline.file.openDiff':
      if (!path) return;
      if (section === 'file.commit' && sha) uiAction({ kind: 'openDiff', target: commitTarget(ctx), path, oldPath: str(ctx.oldPath) || undefined });
      else uiAction({ kind: 'openDiff', target: section === 'file.staged' ? { kind: 'index' } : { kind: 'worktree' }, path });
      return;
    case 'twigline.file.open':
      if (path) uiAction({ kind: 'openFile', path });
      return;
    case 'twigline.file.history':
      if (path) {
        setView('history');
        setQuery({ path, follow: true, search: undefined });
      }
      return;
    case 'twigline.file.reveal':
      if (path) uiAction({ kind: 'revealInOS', path });
      return;
    case 'twigline.file.copyPath':
      if (path) copyText(`${get().boot.root.replace(/[\\/]+$/, '')}/${path}`);
      return;
    case 'twigline.file.resolveCurrent':
      if (path) await runOp({ kind: 'conflict/resolve', paths: targetPaths(path, 'file.conflicted'), side: 'current' });
      return;
    case 'twigline.file.resolveIncoming':
      if (path) await runOp({ kind: 'conflict/resolve', paths: targetPaths(path, 'file.conflicted'), side: 'incoming' });
      return;
    case 'twigline.file.openMergeEditor':
      if (path) uiAction({ kind: 'openMergeEditor', path });
      return;
    case 'twigline.file.markResolved':
      if (path) await runOp({ kind: 'conflict/mark', paths: targetPaths(path, 'file.conflicted'), resolved: true });
      return;
    case 'twigline.file.markUnresolved': {
      if (!path) return;
      const paths = targetPaths(path, 'file.conflicted');
      const ok = await confirm({ title: t('cmd.unresolveTitle'), message: t('cmd.unresolve', paths.join(', ')), okLabel: t('ok'), danger: true });
      if (ok) await runOp({ kind: 'conflict/mark', paths, resolved: false });
      return;
    }

    // ---- file.commit ----
    case 'twigline.commitFile.openRevision':
      if (path && sha) uiAction({ kind: 'openFile', path, sha });
      return;
    case 'twigline.commitFile.compareWorktree':
      if (path && sha) uiAction({ kind: 'compareWithWorktree', sha, path });
      return;
    case 'twigline.commitFile.restore': {
      if (!path || !sha) return;
      const ok = await confirm({ title: t('cmd.restoreTitle'), message: t('cmd.restore', path, shortSha(sha)), okLabel: t('cmd.restoreOk'), danger: true });
      if (ok) await runOp({ kind: 'file/restore', sha, path });
      return;
    }
    default:
      toast('warning', `Unknown command: ${command}`);
  }
}

function subjectOf(sha: string): string {
  return get().rows.find((r) => r.sha === sha)?.subject ?? '';
}

/** The name of the local branch on the commit if there is one, otherwise the SHA */
function preferBranchName(sha: string | undefined): string | undefined {
  if (!sha) return undefined;
  const r = get().snapshot?.refs.find((x) => x.sha === sha && x.kind === 'head' && !x.isHead);
  return r?.name ?? sha;
}

/** Compare with the current branch: select HEAD and the target, two commits, and show the range diff */
function compareWithHead(ref: string | undefined): void {
  const s = get();
  const target = s.snapshot?.refs.find((r) => r.name === ref)?.sha;
  const head = s.snapshot?.head.sha;
  if (!target || !head) return;
  setView('history');
  set({ selected: [head, target], anchor: head, focusSha: target });
  void loadDetail();
}
