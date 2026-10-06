import { useMemo, useState } from 'react';
import type { Operation } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, confirm, openDialog, runOp } from '../../store/actions';
import { useStore } from '../../store/store';
import { pullRequirement, pullStashPaths, pullStatus, type PullMode } from '../../util/pullStatus';
import { cx } from '../../util/format';
import { pullRequestFor, pushComparePair, pushRowDefaults, pushStatus, type PushStatus } from '../../util/pushStatus';
import { PrChip, prDone } from '../PullRequest';
import { Button, Checkbox, Empty, Icon, Select } from '../ui';
import { Advanced, DialogShell, Field, Requirement, RequirementActions, Warning, compareKey, useRefCompare, useRefCompares } from './Dialog';
import { AutostashCheckbox, StashRequirement } from './IntegrateParts';
import { PullStatusCard } from './PullStatusCard';
import { PushStatusCard, STATE_ICON, stateText } from './PushStatusCard';
import { SummaryFiles, SummaryHint } from './SummaryCard';

// Pull, push, fetch

type Snapshot = NonNullable<ReturnType<typeof useStore.getState>['snapshot']>;
type PushOp = Extract<Operation, { kind: 'push' }>;

/** Name of the upstream remote (origin/main -> origin) */
function upstreamRemoteOf(snapshot: Snapshot, upstream: string | undefined) {
  return upstream ? snapshot.remotes.find((r) => upstream.startsWith(r.name + '/'))?.name : undefined;
}

function useRemotes() {
  const snapshot = useStore((s) => s.snapshot)!;
  const upstream = snapshot.head.upstream;
  return { snapshot, upstream, upstreamRemote: upstreamRemoteOf(snapshot, upstream) };
}

export function PullDialog({ remote: initialRemote, branch: initialBranch, into }: { remote?: string; branch?: string; into?: string }) {
  const { snapshot, upstream, upstreamRemote } = useRemotes();
  const status = useStore((s) => s.status);
  const prs = useStore((s) => s.pullRequests);
  // A branch that is not checked out cannot use the working tree, so only fast-forward
  const intoOther = !!into && into !== snapshot.head.branch;
  const [remote, setRemote] = useState(initialRemote ?? upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  // Candidates for remote branches come from the cached refs, not from ls-remote when opened
  const branches = useMemo(
    () => snapshot.refs.filter((r) => r.kind === 'remote' && r.remote === remote).map((r) => r.name.slice(remote.length + 1)),
    [snapshot, remote],
  );
  // The default branch depends on the remote, so it is derived on every render; only what the user typed is kept, per remote
  const preferred = initialBranch ?? (upstream?.startsWith(remote + '/') ? upstream.slice(remote.length + 1) : (snapshot.head.branch ?? ''));
  const [typed, setTyped] = useState<Record<string, string>>({});
  const branch = typed[remote] ?? (branches.includes(preferred) ? preferred : (branches[0] ?? preferred));
  const setBranch = (value: string) => setTyped((prev) => ({ ...prev, [remote]: value }));
  const [mode, setMode] = useState<PullMode>('merge');
  const [autostash, setAutostash] = useState(false);

  const intoName = intoOther ? into : (snapshot.head.branch ?? undefined);
  const local = intoName ? snapshot.refs.find((r) => r.kind === 'head' && r.name === intoName) : undefined;
  const name = branch.trim();
  const target = `${remote}/${name}`;
  const remoteRef = name ? snapshot.refs.find((r) => r.kind === 'remote' && r.name === target) : undefined;
  const ours = intoOther ? local?.sha : (snapshot.head.sha ?? undefined);
  const cmp = useRefCompare(ours, remoteRef?.sha, { files: !intoOther, conflicts: !intoOther });
  // Nothing to compare with when there is no commit to pull into yet (unborn branch)
  const ps = pullStatus({ local, target, remoteRef, cmp: ours ? cmp : null, status: intoOther ? null : status });
  const effectiveMode: PullMode = intoOther ? 'ffOnly' : mode;
  const requirement = pullRequirement(ps, effectiveMode);
  // Merging with autostash needs git 2.27; a rebase has had it longer
  const canAutostash = !intoOther && (effectiveMode === 'rebase' || snapshot.features.pullAutostash);
  const stash = autostash && canAutostash && ps.dirty.length > 0;
  const blocked = requirement === 'ff' || requirement === 'unrelated' || (requirement === 'stash' && !stash);

  if (snapshot.remotes.length === 0) {
    return (
      <DialogShell title={t('pull.title')}>
        <Empty icon="cloud">{t('remote.none')}</Empty>
      </DialogShell>
    );
  }
  const op: Operation | null =
    !remote || !name
      ? null
      : intoOther
        ? { kind: 'pull', remote, branch: name, rebase: false, ffOnly: true, into }
        : { kind: 'pull', remote, branch: name, rebase: mode === 'rebase', ffOnly: mode === 'ffOnly', ...(stash ? { autostash: true } : {}) };
  const remoteFull = `refs/remotes/${target}`;
  const remotePr = prs?.byRef[remoteFull];
  const found = local ? pullRequestFor(prs, local, remote, name) : remotePr ? { pr: remotePr, ref: remoteFull } : undefined;
  const modes: { value: PullMode; label: string; desc: string }[] = [
    { value: 'merge', label: t('pull.mode.merge'), desc: t('pull.mode.mergeDesc') },
    { value: 'rebase', label: t('pull.mode.rebase'), desc: t('pull.mode.rebaseDesc') },
    { value: 'ffOnly', label: t('pull.mode.ffOnly'), desc: t('pull.mode.ffOnlyDesc') },
  ];

  return (
    <DialogShell
      title={t('pull.title')}
      okLabel={t('pull.ok')}
      okDisabled={!op || blocked}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('pull.done') });
      }}
    >
      <Field label={t('remote.remote')}>
        <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: `${r.name}  ${r.fetchUrl ?? ''}` }))} />
      </Field>
      <Field label={t('pull.branch')}>
        <input className="input" list="pull-branches" value={branch} onChange={(e) => setBranch(e.target.value)} />
        <datalist id="pull-branches">
          {branches.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </Field>
      {name && (
        <PullStatusCard
          from={target}
          into={intoName ?? t('detachedHead')}
          remote={remote}
          status={ps}
          mode={effectiveMode}
          blocked={blocked}
          intoOther={intoOther}
          found={found}
          prs={prs}
        />
      )}
      {requirement === 'unrelated' && <Requirement danger title={t('pull.need.unrelated')} detail={t('pull.need.unrelatedDetail')} />}
      {requirement === 'ff' &&
        (intoOther ? (
          <Requirement title={t('pull.need.ff')} detail={t('pull.need.ffOtherDetail', into!)}>
            <RequirementActions>
              <Button
                small
                onClick={async () => {
                  closeDialog();
                  if (await runOp({ kind: 'checkout', ref: into! }, { success: t('cmd.checkedOut', into!) })) openDialog('pull', { remote, branch: name });
                }}
              >
                {t('pull.need.checkout', into!)}
              </Button>
            </RequirementActions>
          </Requirement>
        ) : (
          <Requirement title={t('pull.need.ff')} detail={t('pull.need.ffDetail')}>
            <RequirementActions>
              <Button small onClick={() => setMode('merge')}>
                {t('pull.need.useMerge')}
              </Button>
              <Button small onClick={() => setMode('rebase')}>
                {t('pull.need.useRebase')}
              </Button>
            </RequirementActions>
          </Requirement>
        ))}
      {requirement === 'stash' && (
        <StashRequirement
          status={ps}
          paths={effectiveMode === 'rebase' ? undefined : pullStashPaths(ps, effectiveMode)}
          autostash={canAutostash ? autostash : undefined} onAutostash={setAutostash} />
      )}
      {!intoOther && (
        <div role="radiogroup" aria-label={t('pull.mode')}>
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
      )}
      {requirement !== 'stash' && canAutostash && ps.dirty.length > 0 && (
        <Advanced>
          <AutostashCheckbox checked={autostash} onChange={setAutostash} />
        </Advanced>
      )}
    </DialogShell>
  );
}

/** Push after confirming a force push. lost is the number of remote commits a force push is known to discard */
async function runPush(op: PushOp, lost = 0) {
  if (op.force) {
    const branches = op.branches.map((b) => `${b.local} → ${op.remote}/${b.remote}`).join(', ');
    const ok = await confirm({
      title: t('push.forceConfirmTitle'),
      message: lost > 0 ? t('push.forceConfirmLost', branches, String(lost)) : t('push.forceConfirm', branches),
      okLabel: t('push.forceOk'),
      danger: true,
    });
    if (!ok) return;
  }
  closeDialog();
  await runOp(op, { success: t('push.done') });
}

/** Push of one branch. Defaults to the current branch (from a branch's right-click, that branch) */
export function PushDialog({ branch: initialBranch, setUpstream }: { branch?: string; setUpstream?: boolean }) {
  const { snapshot, upstreamRemote } = useRemotes();
  const forceMode = useStore((s) => s.config?.forcePushMode ?? 'withLease');
  const prs = useStore((s) => s.pullRequests);
  const name = initialBranch ?? snapshot.head.branch ?? undefined;
  const local = snapshot.refs.find((r) => r.kind === 'head' && r.name === name);
  const [remote, setRemote] = useState(upstreamRemoteOf(snapshot, local?.upstream) ?? upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  // The default remote branch name depends on the remote (the upstream's name there, else the same name), so it is derived on every
  // render; only what the user typed is kept, per remote
  const [typed, setTyped] = useState<Record<string, string>>({});
  const remoteName = typed[remote] ?? (local ? pushRowDefaults(local, remote).remote : (name ?? ''));
  const setRemoteName = (value: string) => setTyped((prev) => ({ ...prev, [remote]: value }));
  const [track, setTrack] = useState(setUpstream === true || !local?.upstream);
  const [force, setForce] = useState(false);
  const target = remoteName.trim();
  // A remote branch that is not the upstream is compared on the host
  const pair = local && target ? pushComparePair(local, snapshot.refs, remote, target) : undefined;
  const cmp = useRefCompare(pair?.[0], pair?.[1]);

  if (snapshot.remotes.length === 0 || !name) {
    return (
      <DialogShell title={t('push.title')}>
        <Empty icon="cloud">{snapshot.remotes.length === 0 ? t('remote.none') : t('push.detached')}</Empty>
      </DialogShell>
    );
  }
  const op: PushOp | null = remote && target ? { kind: 'push', remote, branches: [{ local: name, remote: target, setUpstream: track }], tags: false, force } : null;
  const status = local && target ? pushStatus(local, snapshot.refs, remote, target, cmp) : undefined;
  const forceRequired = !!status?.forceRequired;
  // Nothing to send; still allowed when the push would only set the upstream
  const nothing = status?.state === 'upToDate' && !(track && local?.upstream !== `${remote}/${target}`);
  const forceLabel = forceMode === 'force' ? t('push.forcePlain') : t('push.forceLease');

  return (
    <DialogShell
      title={t('push.title')}
      okLabel={force ? t('push.forceOk') : t('push.ok')}
      danger={force}
      okDisabled={!op || nothing || (forceRequired && !force)}
      preview={op}
      onOk={() => (op ? runPush(op, forceRequired ? status!.behind : 0) : undefined)}
    >
      <Field label={t('remote.remote')}>
        <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: `${r.name}  ${r.pushUrl ?? r.fetchUrl ?? ''}` }))} />
      </Field>
      {local && status && <PushStatusCard local={local} remote={remote} remoteName={target} status={status} force={force} prs={prs} />}
      {forceRequired && (
        <Requirement danger title={t('push.forceNeeded')} detail={t('push.forceNeededDetail', String(status!.behind))}>
          <Checkbox checked={force} onChange={setForce} label={forceLabel} />
          <RequirementActions>
            <Button small onClick={() => openDialog('pull')}>
              {t('menu.pull')}
            </Button>
          </RequirementActions>
        </Requirement>
      )}
      <Checkbox checked={track} onChange={setTrack} label={t('push.setUpstream')} />
      <Advanced>
        <Field label={t('push.remoteName')}>
          <input className="input" value={remoteName} onChange={(e) => setRemoteName(e.target.value)} />
        </Field>
        {!forceRequired && <Checkbox checked={force} onChange={setForce} label={forceLabel} />}
      </Advanced>
      {force && !forceRequired && <Warning danger>{t('push.forceWarning')}</Warning>}
      {force && forceRequired && forceMode === 'withLease' && <SummaryHint>{t('push.leaseHint')}</SummaryHint>}
    </DialogShell>
  );
}

/** What the user changed in a row (the rest comes from pushRowDefaults) */
interface RowEdit {
  remote?: string;
  checked?: boolean;
  track?: boolean;
}

/** Short state for the table, with the full sentence as the tooltip */
function PushRowState({ status }: { status: PushStatus | undefined }) {
  if (!status) return <span />;
  const short =
    status.state === 'ahead' || status.state === 'behind' || status.state === 'diverged'
      ? [status.ahead > 0 && `↑${status.ahead}`, status.behind > 0 && `↓${status.behind}`].filter(Boolean).join(' ')
      : t(`pushBranches.state.${status.state}`);
  return (
    <span className={cx('push-row-state', status.forceRequired && 'warn', status.state === 'upToDate' && 'dim')} title={stateText(status)}>
      <Icon name={STATE_ICON[status.state]} />
      {short}
    </span>
  );
}

/**
 * Push several branches (and tags) together. By default, selects the branches that have unpushed commits and can be pushed without force.
 * The defaults of a row depend on the remote, so they are derived from it on every render; only the user's edits are kept, per remote
 * (switching the remote shows that remote's defaults, and switching back brings the edits back)
 */
export function PushBranchesDialog() {
  const { snapshot, upstreamRemote } = useRemotes();
  const forceMode = useStore((s) => s.config?.forcePushMode ?? 'withLease');
  const prs = useStore((s) => s.pullRequests);
  const [remote, setRemote] = useState(upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [tags, setTags] = useState(false);
  const [force, setForce] = useState(false);

  const editKey = (local: string) => JSON.stringify([remote, local]);
  const base = snapshot.refs
    .filter((r) => r.kind === 'head')
    .map((ref) => {
      const row = { ref, ...pushRowDefaults(ref, remote), ...edits[editKey(ref.name)] };
      const target = row.remote.trim();
      // A remote branch that is not the upstream is compared on the host
      return { ...row, target, pair: target ? pushComparePair(ref, snapshot.refs, remote, target) : undefined };
    });
  const cmps = useRefCompares(base.flatMap((r) => (r.pair ? [r.pair] : [])));
  const rows = base.map((r) => ({
    ...r,
    status: r.target ? pushStatus(r.ref, snapshot.refs, remote, r.target, r.pair && cmps.get(compareKey(...r.pair))) : undefined,
    pr: r.target ? pullRequestFor(prs, r.ref, remote, r.target) : undefined,
  }));

  if (snapshot.remotes.length === 0) {
    return (
      <DialogShell title={t('pushBranches.title')}>
        <Empty icon="cloud">{t('remote.none')}</Empty>
      </DialogShell>
    );
  }
  const selected = rows.filter((r) => r.checked);
  const op: PushOp | null =
    remote && (selected.length > 0 || tags) && selected.every((r) => r.target)
      ? { kind: 'push', remote, branches: selected.map((r) => ({ local: r.ref.name, remote: r.target, setUpstream: r.track })), tags, force }
      : null;
  const needForce = selected.filter((r) => r.status?.forceRequired);
  const lost = needForce.reduce((n, r) => n + (r.status?.behind ?? 0), 0);
  const commits = selected.reduce((n, r) => n + (r.status?.ahead ?? 0), 0);
  // A branch new to the remote has no remote branch to count against, so it is not in commits and is told separately
  const created = selected.filter((r) => r.status?.state === 'new' || r.status?.state === 'gone').length;
  const update = (patches: Record<string, RowEdit>) =>
    setEdits((prev) => {
      const next = { ...prev };
      for (const [local, patch] of Object.entries(patches)) next[editKey(local)] = { ...prev[editKey(local)], ...patch };
      return next;
    });
  const forceLabel = forceMode === 'force' ? t('push.forcePlain') : t('push.forceLease');

  return (
    <DialogShell
      title={t('pushBranches.title')}
      wide
      okLabel={force ? t('push.forceOk') : t('push.ok')}
      danger={force}
      okDisabled={!op || (needForce.length > 0 && !force)}
      preview={op}
      onOk={() => (op ? runPush(op, force ? lost : 0) : undefined)}
    >
      <Field label={t('remote.remote')}>
        <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: `${r.name}  ${r.pushUrl ?? r.fetchUrl ?? ''}` }))} />
      </Field>
      <div className="table push-table" role="table">
        <div className="tr th" role="row">
          <span />
          <span>{t('push.local')}</span>
          <span>{t('push.remoteName')}</span>
          <span>{t('pushBranches.state')}</span>
          <span>{t('push.track')}</span>
        </div>
        {rows.map((r) => (
          <div className={cx('tr', r.checked && r.status?.forceRequired && 'warn')} role="row" key={r.ref.name}>
            <input type="checkbox" checked={r.checked} onChange={(e) => update({ [r.ref.name]: { checked: e.target.checked } })} aria-label={r.ref.name} />
            <span className="push-row-local">
              <span className={cx('mono ellipsis', prDone(r.pr?.pr) && 'pr-done')} title={r.ref.name}>
                {r.ref.name}
              </span>
              {r.pr && <PrChip pr={r.pr.pr} refName={r.pr.ref} />}
            </span>
            <input className="input" value={r.remote} onChange={(e) => update({ [r.ref.name]: { remote: e.target.value } })} aria-label={t('push.remoteName')} />
            <PushRowState status={r.status} />
            <input type="checkbox" checked={r.track} onChange={(e) => update({ [r.ref.name]: { track: e.target.checked } })} aria-label={t('push.track')} />
          </div>
        ))}
      </div>
      <SummaryHint>
        {t('pushBranches.summary', String(selected.length), String(commits))} {created > 0 && `${t('pushBranches.summaryNew', String(created))} `}
        {t('summary.staleHint')}
      </SummaryHint>
      {needForce.length > 0 && (
        <Requirement
          danger
          title={t('push.forceNeeded')}
          detail={t('pushBranches.forceNeededDetail', needForce.map((r) => t('pushBranches.lostOf', r.ref.name, String(r.status!.behind))).join(', '))}
        >
          <Checkbox checked={force} onChange={setForce} label={forceLabel} />
          <RequirementActions>
            <Button small onClick={() => update(Object.fromEntries(needForce.map((r) => [r.ref.name, { checked: false }])))}>
              {t('pushBranches.uncheckForce')}
            </Button>
          </RequirementActions>
        </Requirement>
      )}
      <Checkbox checked={tags} onChange={setTags} label={t('push.tags')} />
      {needForce.length === 0 && (
        <Advanced>
          <Checkbox checked={force} onChange={setForce} label={forceLabel} />
        </Advanced>
      )}
      {force && needForce.length === 0 && <Warning danger>{t('push.forceWarning')}</Warning>}
      {force && needForce.length > 0 && forceMode === 'withLease' && <SummaryHint>{t('push.leaseHint')}</SummaryHint>}
    </DialogShell>
  );
}

export function FetchDialog() {
  const { snapshot, upstreamRemote } = useRemotes();
  const [all, setAll] = useState(true);
  const [remote, setRemote] = useState(upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  const [prune, setPrune] = useState(false);
  const [tags, setTags] = useState(false);
  if (snapshot.remotes.length === 0) {
    return (
      <DialogShell title={t('fetch.title')}>
        <Empty icon="cloud">{t('remote.none')}</Empty>
      </DialogShell>
    );
  }
  const op: Operation = { kind: 'fetch', remote: all ? '*' : remote, prune, tags };
  return (
    <DialogShell
      title={t('fetch.title')}
      okLabel={t('fetch.ok')}
      preview={op}
      onOk={async () => {
        closeDialog();
        await runOp(op, { success: t('fetch.done') });
      }}
    >
      <Checkbox checked={all} onChange={setAll} label={t('fetch.all')} />
      {!all && (
        <Field label={t('remote.remote')}>
          <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: r.name }))} />
        </Field>
      )}
      <Checkbox checked={prune} onChange={setPrune} label={t('fetch.prune')} />
      <Checkbox checked={tags} onChange={setTags} label={t('fetch.tags')} />
    </DialogShell>
  );
}
