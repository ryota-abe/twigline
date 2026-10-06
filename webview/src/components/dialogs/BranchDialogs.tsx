import { useMemo, useState } from 'react';
import type { Operation, RefInfo } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, confirm, getRpc, runOp } from '../../store/actions';
import { get, useStore } from '../../store/store';
import { deleteInfo, safeToDelete, type DeleteInfo } from '../../util/branchDelete';
import { cx, shortSha } from '../../util/format';
import { integrateStatus, makesMergeCommit, mergeRequirement, mergeStashPaths, rebaseRequirement, type MergeMode } from '../../util/integrate';
import { resetStatus, type ResetMode } from '../../util/resetStatus';
import { PrChip, prDone, prOf } from '../PullRequest';
import { Button, Checkbox, Select } from '../ui';
import { Advanced, DialogShell, Field, Requirement, RequirementActions, Warning, useAheadBehind, useRefCompare, useRefNameValidation, useRequest } from './Dialog';
import { AutostashCheckbox, StashRequirement } from './IntegrateParts';
import { MergeStatusCard, RebaseStatusCard } from './MergeRebaseCards';
import { ResetStatusCard } from './ResetStatusCard';
import { SummaryHint } from './SummaryCard';

// Branch, checkout, merge, rebase, reset

type Snapshot = NonNullable<ReturnType<typeof useStore.getState>['snapshot']>;

/**
 * Choices for the start point of a branch or tag to create. HEAD first, then branches, remote branches and tags.
 * If initial (such as the right-clicked commit) is not the name of a ref, it is added after HEAD as a commit
 */
export function startOptions(snapshot: Snapshot, headLabel: string, initial?: string) {
  const first = initialStart(snapshot, initial);
  return [{ value: 'HEAD', label: headLabel }, ...refOptions(snapshot, first === 'HEAD' ? undefined : first)];
}

/** Initial start point. The current branch is folded into HEAD in the choices */
export function initialStart(snapshot: Snapshot, initial?: string): string {
  return !initial || initial === snapshot.head.branch ? 'HEAD' : initial;
}

/** Whether a branch is merged into HEAD and pushed, after its name in the delete list */
function DeleteBadges({ info, upstream }: { info: DeleteInfo; upstream: string | undefined }) {
  if (info.unmerged === undefined) return null;
  return (
    <>
      {info.unmerged === 0 ? (
        <span className="mini-badge ok" title={t('branch.badge.mergedTitle')}>
          {t('branch.badge.merged')}
        </span>
      ) : (
        <span className="mini-badge warn" title={t('branch.badge.unmergedTitle', String(info.unmerged))}>
          {t('branch.badge.unmerged', String(info.unmerged))}
        </span>
      )}
      {!!info.unpushed && (
        <span className="mini-badge warn" title={t('branch.badge.unpushedTitle', String(info.unpushed), upstream ?? '')}>
          {t('branch.badge.unpushed', String(info.unpushed))}
        </span>
      )}
      {info.unpushed === undefined && info.unmerged > 0 && (
        <span className="mini-badge warn" title={t('branch.badge.localOnlyTitle')}>
          {t('branch.badge.localOnly')}
        </span>
      )}
    </>
  );
}

/** A branch can be created from HEAD, the right-clicked ref or a commit. Deletion chooses from all branches other than the current one */
export function BranchDialog({ tab: initialTab, start: initial, names }: { tab?: 'new' | 'delete'; start?: string; names?: string[] }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const prs = useStore((s) => s.pullRequests);
  const [tab, setTab] = useState<'new' | 'delete'>(initialTab ?? 'new');
  const locals = snapshot.refs.filter((r) => r.kind === 'head');
  const existing = useMemo(() => locals.map((r) => r.name), [locals]);

  // Create
  const [name, setName] = useState('');
  const [start, setStart] = useState(initialStart(snapshot, initial));
  const starts = startOptions(snapshot, t('branch.fromHead', snapshot.head.branch ?? shortSha(snapshot.head.sha ?? '')), initial);
  const [checkout, setCheckout] = useState(true);
  const validation = useRefNameValidation(name, existing);

  // Delete
  const deletable = locals.filter((r) => !r.isHead);
  const [picked, setPicked] = useState<Set<string>>(new Set(names ?? []));
  const [force, setForce] = useState(false);
  const [withRemote, setWithRemote] = useState(false);
  // How many commits of each branch HEAD lacks (asked only on the delete tab)
  const counts = useAheadBehind(tab === 'delete' ? (snapshot.head.sha ?? undefined) : undefined, tab === 'delete' ? deletable : []);
  const infos = new Map(deletable.map((r) => [r.name, deleteInfo(r, counts?.[r.fullName]?.ahead)]));
  const chosen = deletable.filter((r) => picked.has(r.name));
  const needForce = chosen.filter((r) => infos.get(r.name)!.forceRequired);
  const atRisk = chosen.filter((r) => infos.get(r.name)!.atRisk > 0);
  const tracked = (r: RefInfo) => !!r.upstream && !r.gone;
  // Deleting the head branch of an open PR on the remote closes the PR
  const closingPrs = withRemote
    ? [
        ...new Map(
          chosen
            .filter(tracked)
            .map((r) => prs?.byRef[`refs/remotes/${r.upstream}`] ?? prOf(prs, r))
            .filter((pr) => pr?.state === 'open' || pr?.state === 'draft')
            .map((pr) => [pr!.number, pr!]),
        ).values(),
      ]
    : [];

  const createOp: Operation | null =
    validation.valid && name.trim() ? { kind: 'branch/create', name: name.trim(), start, checkout } : null;
  // A remote branch that is already deleted is left out (deleting it again would fail)
  const remoteBranches = withRemote
    ? chosen
        .filter(tracked)
        .map((r) => {
          const remote = snapshot.remotes.find((x) => r.upstream!.startsWith(x.name + '/'))?.name ?? r.upstream!.split('/')[0];
          return { remote, branch: r.upstream!.slice(remote.length + 1) };
        })
    : undefined;
  const deleteOp: Operation | null = chosen.length > 0 ? { kind: 'branch/delete', names: chosen.map((r) => r.name), force, remoteBranches } : null;
  const countsOf = (list: RefInfo[], n: (i: DeleteInfo) => number) => list.map((r) => t('branch.countOf', r.name, String(n(infos.get(r.name)!)))).join(', ');
  const setPick = (list: string[], on: boolean) => {
    const next = new Set(picked);
    for (const n of list) {
      if (on) next.add(n);
      else next.delete(n);
    }
    setPicked(next);
  };

  return (
    <DialogShell
      title={t('branch.title')}
      okLabel={tab === 'new' ? t('branch.create') : t('branch.delete')}
      danger={tab === 'delete'}
      okDisabled={tab === 'new' ? !createOp : !deleteOp || (needForce.length > 0 && !force)}
      preview={tab === 'new' ? createOp : deleteOp}
      onOk={async () => {
        if (tab === 'new' && createOp) {
          closeDialog();
          await runOp(createOp, { success: t('branch.created', name.trim()) });
        } else if (tab === 'delete' && deleteOp) {
          const list = chosen.map((r) => r.name).join(', ');
          const ok = await confirm({
            title: t('branch.deleteConfirmTitle'),
            message: [
              t('branch.deleteConfirm', String(chosen.length), list),
              remoteBranches?.length ? t('branch.deleteRemoteToo', remoteBranches.map((r) => `${r.remote}/${r.branch}`).join(', ')) : '',
              force && atRisk.length > 0 ? t('branch.deleteAtRisk', countsOf(atRisk, (i) => i.atRisk)) : '',
              closingPrs.length > 0 ? t('branch.prWillClose', closingPrs.map((pr) => `#${pr.number}`).join(', ')) : '',
            ]
              .filter(Boolean)
              .join('\n'),
            okLabel: t('branch.delete'),
            danger: true,
          });
          if (!ok) return;
          closeDialog();
          await runOp(deleteOp, { success: t('branch.deleted', String(chosen.length)) });
        }
      }}
    >
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'new'} className={cx('tab', tab === 'new' && 'on')} onClick={() => setTab('new')}>
          {t('branch.newTab')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'delete'} className={cx('tab', tab === 'delete' && 'on')} onClick={() => setTab('delete')}>
          {t('branch.deleteTab')}
        </button>
      </div>
      {tab === 'new' ? (
        <>
          <Field label={t('branch.name')} error={name.trim() ? validation.message : undefined}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="feature/…" data-vscode-context='{"preventDefaultContextMenuItems":false}' />
          </Field>
          <Field label={t('branch.start')}>
            <Select value={start} onChange={setStart} options={starts} />
          </Field>
          <Checkbox checked={checkout} onChange={setCheckout} label={t('branch.checkoutAfter')} />
        </>
      ) : (
        <>
          <div className="check-list">
            {deletable.length === 0 && <div className="dim">{t('branch.noneToDelete')}</div>}
            {deletable.map((r) => {
              // As a hint for whether it is safe to delete, show the PR state (merged, etc.) and the merge state after the name
              // (placed before the upstream, which is long and may be cut off)
              const pr = prOf(prs, r);
              return (
                <Checkbox
                  key={r.name}
                  checked={picked.has(r.name)}
                  onChange={(v) => setPick([r.name], v)}
                  label={
                    <>
                      <span className={cx('mono', prDone(pr) && 'pr-done')}>{r.name}</span>
                      {pr && <PrChip pr={pr} refName={r.fullName} />}
                      <DeleteBadges info={infos.get(r.name)!} upstream={r.upstream} />
                      {r.upstream && <span className="dim"> → {r.upstream}</span>}
                    </>
                  }
                />
              );
            })}
          </div>
          <span className="row">
            <Button small disabled={!counts} onClick={() => setPick(deletable.filter((r) => safeToDelete(infos.get(r.name)!)).map((r) => r.name), true)}>
              {t('branch.selectMerged')}
            </Button>
            <Button small disabled={picked.size === 0} onClick={() => setPicked(new Set())}>
              {t('selectNone')}
            </Button>
          </span>
          {needForce.length > 0 && (
            <Requirement danger title={t('branch.forceNeeded')} detail={t('branch.forceNeededDetail', countsOf(needForce, (i) => i.unpushed ?? i.unmerged ?? 0))}>
              <Checkbox checked={force} onChange={setForce} label={t('branch.force')} />
              <RequirementActions>
                <Button small onClick={() => setPick(needForce.map((r) => r.name), false)}>
                  {t('branch.uncheckForce')}
                </Button>
              </RequirementActions>
            </Requirement>
          )}
          <Checkbox checked={withRemote} onChange={setWithRemote} label={t('branch.withRemote')} />
          {closingPrs.length > 0 && <SummaryHint warn>{t('branch.prWillClose', closingPrs.map((pr) => `#${pr.number}`).join(', '))}</SummaryHint>}
          {needForce.length === 0 && (
            <Advanced>
              <Checkbox checked={force} onChange={setForce} label={t('branch.force')} />
            </Advanced>
          )}
          {force && needForce.length === 0 && <Warning danger>{t('branch.forceWarning')}</Warning>}
          {force && atRisk.length > 0 && <Warning danger>{t('branch.deleteAtRisk', countsOf(atRisk, (i) => i.atRisk))}</Warning>}
        </>
      )}
    </DialogShell>
  );
}

/** Checkout of a commit or a remote branch */
export function CheckoutDialog({ sha, remoteRef, remote }: { sha?: string; remoteRef?: string; remote?: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const locals = snapshot.refs.filter((r) => r.kind === 'head');
  const existing = useMemo(() => locals.map((r) => r.name), [locals]);

  if (remoteRef) {
    const remoteName = remote ?? snapshot.remotes.find((r) => remoteRef.startsWith(r.name + '/'))?.name ?? remoteRef.split('/')[0];
    const short = remoteRef.slice(remoteName.length + 1);
    return <RemoteCheckout remoteRef={remoteRef} defaultName={short} existing={existing} />;
  }

  const branchesHere = locals.filter((r) => r.sha === sha && !r.isHead);
  return <CommitCheckout sha={sha!} branches={branchesHere.map((r) => r.name)} />;
}

function RemoteCheckout({ remoteRef, defaultName, existing }: { remoteRef: string; defaultName: string; existing: string[] }) {
  const [name, setName] = useState(existing.includes(defaultName) ? '' : defaultName);
  const [useExisting, setUseExisting] = useState(existing.includes(defaultName));
  const validation = useRefNameValidation(name, existing);
  const op: Operation | null = useExisting
    ? { kind: 'checkout', ref: defaultName }
    : validation.valid
      ? { kind: 'checkout', ref: remoteRef, createTracking: name.trim() }
      : null;
  return (
    <DialogShell
      title={t('checkout.remoteTitle', remoteRef)}
      okLabel={t('checkout.ok')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op);
      }}
    >
      {existing.includes(defaultName) && (
        <label className="radio">
          <input type="radio" checked={useExisting} onChange={() => setUseExisting(true)} />
          {t('checkout.existing', defaultName)}
        </label>
      )}
      <label className="radio">
        <input type="radio" checked={!useExisting} onChange={() => setUseExisting(false)} />
        {t('checkout.newLocal')}
      </label>
      {!useExisting && (
        <Field label={t('branch.name')} error={name.trim() ? validation.message : undefined} hint={t('checkout.trackHint', remoteRef)}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
    </DialogShell>
  );
}

function CommitCheckout({ sha, branches }: { sha: string; branches: string[] }) {
  const [choice, setChoice] = useState<string>(branches[0] ?? '');
  const op: Operation = choice ? { kind: 'checkout', ref: choice } : { kind: 'checkout', ref: sha, detach: true };
  return (
    <DialogShell
      title={t('checkout.commitTitle', shortSha(sha))}
      okLabel={t('checkout.ok')}
      preview={op}
      onOk={async () => {
        closeDialog();
        await runOp(op);
      }}
    >
      {branches.map((b) => (
        <label key={b} className="radio">
          <input type="radio" checked={choice === b} onChange={() => setChoice(b)} />
          {t('checkout.branchAtCommit', b)}
        </label>
      ))}
      <label className="radio">
        <input type="radio" checked={choice === ''} onChange={() => setChoice('')} />
        {t('checkout.detached')}
      </label>
      {choice === '' && <Warning>{t('checkout.detachedWarning')}</Warning>}
    </DialogShell>
  );
}

export function RenameBranchDialog({ name }: { name: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const existing = useMemo(() => snapshot.refs.filter((r) => r.kind === 'head').map((r) => r.name), [snapshot]);
  const [next, setNext] = useState(name);
  const validation = useRefNameValidation(next, existing.filter((x) => x !== name));
  const op: Operation | null = validation.valid && next.trim() !== name ? { kind: 'branch/rename', from: name, to: next.trim() } : null;
  return (
    <DialogShell
      title={t('rename.title', name)}
      okLabel={t('rename.ok')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op);
      }}
    >
      <Field label={t('branch.name')} error={next.trim() && next !== name ? validation.message : undefined}>
        <input className="input" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
    </DialogShell>
  );
}

export function SetUpstreamDialog({ branch }: { branch: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const current = snapshot.refs.find((r) => r.kind === 'head' && r.name === branch)?.upstream ?? '';
  const remotes = snapshot.refs.filter((r) => r.kind === 'remote').map((r) => r.name);
  const [upstream, setUpstream] = useState(current);
  const op: Operation = { kind: 'branch/setUpstream', branch, upstream: upstream || null };
  return (
    <DialogShell
      title={t('upstream.title', branch)}
      okLabel={t('ok')}
      preview={op}
      onOk={async () => {
        closeDialog();
        await runOp(op);
      }}
    >
      <Field label={t('upstream.remoteBranch')}>
        <Select value={upstream} onChange={setUpstream} options={[{ value: '', label: t('upstream.none') }, ...remotes.map((r) => ({ value: r, label: r }))]} />
      </Field>
    </DialogShell>
  );
}

function refOptions(snapshot: Snapshot, extra?: string) {
  const opts: { value: string; label: string }[] = [];
  if (extra && !snapshot.refs.some((r) => r.name === extra)) opts.push({ value: extra, label: /^[0-9a-f]{7,}$/.test(extra) ? `${t('commitWord')} ${shortSha(extra)}` : extra });
  for (const r of snapshot.refs) {
    if (r.kind === 'head' && r.isHead) continue;
    opts.push({ value: r.name, label: `${r.kind === 'head' ? '⎇' : r.kind === 'remote' ? '☁' : '🏷'} ${r.name}` });
  }
  return opts;
}

/** The commit a ref option points to (a SHA option is the commit itself), so a moved ref is compared again */
function commitOf(snapshot: Snapshot, rev: string): string | undefined {
  return snapshot.refs.find((r) => r.name === rev)?.sha ?? (/^[0-9a-f]{4,64}$/i.test(rev) ? rev : undefined);
}

/** Name of a ref option as shown in the summary card */
function revLabel(rev: string): string {
  return /^[0-9a-f]{7,}$/.test(rev) ? `${t('commitWord')} ${shortSha(rev)}` : rev;
}

export function MergeDialog({ ref: initial }: { ref?: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const status = useStore((s) => s.status);
  const prs = useStore((s) => s.pullRequests);
  const options = refOptions(snapshot, initial);
  const [ref, setRef] = useState(initial ?? options[0]?.value ?? '');
  const [mode, setMode] = useState<MergeMode>('auto');
  const [commitNow, setCommitNow] = useState(true);
  const [autostash, setAutostash] = useState(false);

  const local = snapshot.refs.find((r) => r.kind === 'head' && r.isHead);
  const cmp = useRefCompare(snapshot.head.sha ?? undefined, ref ? commitOf(snapshot, ref) : undefined, { files: true, conflicts: true });
  const ms = integrateStatus({ local, target: ref, cmp: snapshot.head.sha ? cmp : null, status });
  const requirement = mergeRequirement(ms, mode);
  const canAutostash = snapshot.features.pullAutostash;
  const stash = autostash && canAutostash && ms.dirty.length > 0;
  const blocked = requirement === 'unrelated' || (requirement === 'stash' && !stash);
  const source = snapshot.refs.find((r) => r.name === ref);
  const pr = source ? prOf(prs, source) : undefined;

  const op: Operation | null = ref
    ? { kind: 'merge', ref, noFastForward: mode === 'noFf', squash: mode === 'squash', commit: commitNow, ...(stash ? { autostash: true } : {}) }
    : null;
  const modes: { value: MergeMode; label: string; desc: string }[] = [
    { value: 'auto', label: t('merge.mode.auto'), desc: t('merge.mode.autoDesc') },
    { value: 'noFf', label: t('merge.mode.noFf'), desc: t('merge.mode.noFfDesc') },
    { value: 'squash', label: t('merge.mode.squash'), desc: t('merge.mode.squashDesc') },
  ];
  return (
    <DialogShell
      title={t('merge.title')}
      okLabel={t('merge.ok')}
      // Merging something already merged does nothing
      okDisabled={!op || blocked || ms.state === 'upToDate'}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('merge.done') });
      }}
    >
      <Field label={t('merge.source')}>
        <Select value={ref} onChange={setRef} options={options} />
      </Field>
      {ref && (
        <MergeStatusCard
          source={revLabel(ref)}
          into={snapshot.head.branch ?? t('detachedHead')}
          status={ms}
          mode={mode}
          commit={commitNow}
          blocked={blocked}
          found={pr && source ? { pr, ref: source.fullName } : undefined}
        />
      )}
      {requirement === 'unrelated' && <Requirement danger title={t('merge.need.unrelated')} detail={t('merge.need.unrelatedDetail')} />}
      {requirement === 'stash' && <StashRequirement status={ms} paths={mergeStashPaths(ms, makesMergeCommit(ms, mode))} autostash={canAutostash ? autostash : undefined} onAutostash={setAutostash} />}
      <div role="radiogroup" aria-label={t('merge.mode')}>
        {modes.map((m) => (
          <label key={m.value} className="radio block">
            <input type="radio" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span>
              <b>{m.label}</b>
              <span className="dim block">{m.desc}</span>
            </span>
          </label>
        ))}
      </div>
      <Advanced>
        <Checkbox checked={commitNow} onChange={setCommitNow} label={t('merge.commit')} disabled={mode === 'squash'} />
        {requirement !== 'stash' && canAutostash && ms.dirty.length > 0 && <AutostashCheckbox checked={autostash} onChange={setAutostash} />}
      </Advanced>
    </DialogShell>
  );
}

export function RebaseDialog({ onto: initial }: { onto?: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const status = useStore((s) => s.status);
  const prs = useStore((s) => s.pullRequests);
  const options = refOptions(snapshot, initial);
  const [onto, setOnto] = useState(initial ?? options[0]?.value ?? '');
  const [autostash, setAutostash] = useState(false);
  const [updateRefs, setUpdateRefs] = useState(false);

  const local = snapshot.refs.find((r) => r.kind === 'head' && r.isHead);
  const cmp = useRefCompare(snapshot.head.sha ?? undefined, onto ? commitOf(snapshot, onto) : undefined, { files: true, conflicts: true });
  const rs = integrateStatus({ local, target: onto, cmp: snapshot.head.sha ? cmp : null, status });
  const requirement = rebaseRequirement(rs);
  const blocked = requirement === 'stash' && !autostash;
  const pr = local ? prOf(prs, local) : undefined;

  const op: Operation | null = onto ? { kind: 'rebase', onto, autostash: autostash && rs.dirty.length > 0, updateRefs } : null;
  return (
    <DialogShell
      title={t('rebase.title')}
      okLabel={t('rebase.ok')}
      // Already on top of it: a rebase changes nothing
      okDisabled={!op || blocked || rs.state === 'upToDate'}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('rebase.done') });
      }}
    >
      <Field label={t('rebase.onto')}>
        <Select value={onto} onChange={setOnto} options={options} />
      </Field>
      {onto && (
        <RebaseStatusCard
          branch={snapshot.head.branch ?? t('detachedHead')}
          onto={revLabel(onto)}
          status={rs}
          blocked={blocked}
          found={pr && local ? { pr, ref: local.fullName } : undefined}
        />
      )}
      {requirement === 'stash' && <StashRequirement status={rs} paths={undefined} autostash={autostash} onAutostash={setAutostash} />}
      {snapshot.features.updateRefs && (
        <Advanced>
          <Checkbox checked={updateRefs} onChange={setUpdateRefs} label={t('rebase.updateRefs')} />
        </Advanced>
      )}
    </DialogShell>
  );
}

export function ResetDialog({ sha }: { sha: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const status = useStore((s) => s.status);
  const prs = useStore((s) => s.pullRequests);
  const [mode, setMode] = useState<ResetMode>('mixed');

  const head = snapshot.head.sha ?? undefined;
  const branch = snapshot.head.branch ?? undefined;
  const local = snapshot.refs.find((r) => r.kind === 'head' && r.isHead);
  const upstream = local?.upstream && !local.gone ? snapshot.refs.find((r) => r.kind === 'remote' && r.name === local.upstream) : undefined;
  const cmp = useRefCompare(head, sha);
  const toUpstream = useRefCompare(sha, upstream?.sha);
  const orphaned = useRequest(head ? JSON.stringify([head, sha, branch]) : '', (signal) =>
    getRpc().request('ref/exclusive', { repo: get().boot.repo, from: head!, to: sha, branch }, signal),
  );
  const rs = resetStatus({ local, cmp: head ? cmp : null, toUpstream: upstream ? toUpstream : undefined, orphaned, mode, status });
  const pr = local ? prOf(prs, local) : undefined;

  const op: Operation = { kind: 'reset', sha, mode };
  const modes: { value: ResetMode; label: string; desc: string }[] = [
    { value: 'soft', label: t('reset.soft'), desc: t('reset.softDesc') },
    { value: 'mixed', label: t('reset.mixed'), desc: t('reset.mixedDesc') },
    { value: 'hard', label: t('reset.hard'), desc: t('reset.hardDesc') },
  ];
  const orphanedCount = rs.orphaned ?? 0;
  return (
    <DialogShell
      title={t('reset.title', branch ?? 'HEAD', shortSha(sha))}
      okLabel={t('reset.ok')}
      danger={mode === 'hard'}
      okDisabled={rs.nothing}
      preview={op}
      onOk={async () => {
        // A hard reset discards what cannot be recovered (uncommitted changes) and drops commits from every ref: confirm both
        if (mode === 'hard' && (rs.discarded > 0 || orphanedCount > 0)) {
          const message = [
            rs.discarded > 0 ? t('reset.hardConfirm', String(rs.discarded)) : '',
            orphanedCount > 0 ? t('reset.orphaned', String(orphanedCount)) : '',
          ]
            .filter(Boolean)
            .join('\n');
          const ok = await confirm({ title: t('reset.hardConfirmTitle'), message, okLabel: t('reset.ok'), danger: true });
          if (!ok) return;
        }
        closeDialog();
        await runOp(op);
      }}
    >
      <ResetStatusCard
        from={branch ?? t('detachedHead')}
        to={`${t('commitWord')} ${shortSha(sha)}`}
        status={rs}
        mode={mode}
        found={pr && local ? { pr, ref: local.fullName } : undefined}
      />
      <div role="radiogroup" aria-label={t('reset.mode')}>
        {modes.map((m) => (
          <label key={m.value} className="radio block">
            <input type="radio" checked={mode === m.value} onChange={() => setMode(m.value)} />
            <span>
              <b>{m.label}</b>
              <span className="dim block">{m.desc}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'hard' && rs.discarded > 0 && <Warning danger>{t('reset.hardWarning', String(rs.discarded))}</Warning>}
    </DialogShell>
  );
}
