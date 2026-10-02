import { useMemo, useState } from 'react';
import type { Operation } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, confirm, runOp } from '../../store/actions';
import { useStore } from '../../store/store';
import { Checkbox, Empty, Select } from '../ui';
import { DialogShell, Field, Warning } from './Dialog';

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
  // A branch that is not checked out cannot use the working tree, so only fast-forward
  const intoOther = !!into && into !== snapshot.head.branch;
  const [remote, setRemote] = useState(initialRemote ?? upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  // Candidates for remote branches come from the cached refs, not from ls-remote when opened
  const branches = useMemo(
    () => snapshot.refs.filter((r) => r.kind === 'remote' && r.remote === remote).map((r) => r.name.slice(remote.length + 1)),
    [snapshot, remote],
  );
  const preferred = initialBranch ?? (upstream?.startsWith(remote + '/') ? upstream.slice(remote.length + 1) : (snapshot.head.branch ?? ''));
  const [branch, setBranch] = useState(branches.includes(preferred) ? preferred : (branches[0] ?? preferred));
  const [rebase, setRebase] = useState(false);
  const [ffOnly, setFfOnly] = useState(false);

  if (snapshot.remotes.length === 0) {
    return (
      <DialogShell title={t('pull.title')}>
        <Empty icon="cloud">{t('remote.none')}</Empty>
      </DialogShell>
    );
  }
  const op: Operation | null = !remote || !branch ? null : intoOther ? { kind: 'pull', remote, branch, rebase: false, ffOnly: true, into } : { kind: 'pull', remote, branch, rebase, ffOnly };
  return (
    <DialogShell
      title={t('pull.title')}
      okLabel={t('pull.ok')}
      okDisabled={!op}
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
      <Field label={t('pull.into')} hint={intoOther ? t('pull.intoOther') : undefined}>
        <span className="readonly">{intoOther ? into : (snapshot.head.branch ?? t('detachedHead'))}</span>
      </Field>
      {!intoOther && (
        <>
          <Checkbox checked={rebase} onChange={(v) => { setRebase(v); if (v) setFfOnly(false); }} label={t('pull.rebase')} />
          <Checkbox checked={ffOnly} onChange={(v) => { setFfOnly(v); if (v) setRebase(false); }} label={t('pull.ffOnly')} />
        </>
      )}
    </DialogShell>
  );
}

/** Push after confirming a force push */
async function runPush(op: PushOp) {
  if (op.force) {
    const ok = await confirm({
      title: t('push.forceConfirmTitle'),
      message: t('push.forceConfirm', op.branches.map((b) => `${b.local} → ${op.remote}/${b.remote}`).join(', ')),
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
  const name = initialBranch ?? snapshot.head.branch ?? undefined;
  const local = snapshot.refs.find((r) => r.kind === 'head' && r.name === name);
  const [remote, setRemote] = useState(upstreamRemoteOf(snapshot, local?.upstream) ?? upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  const [remoteName, setRemoteName] = useState(local?.upstream?.startsWith(remote + '/') ? local.upstream.slice(remote.length + 1) : (name ?? ''));
  const [track, setTrack] = useState(setUpstream === true || !local?.upstream);
  const [force, setForce] = useState(false);

  if (snapshot.remotes.length === 0 || !name) {
    return (
      <DialogShell title={t('push.title')}>
        <Empty icon="cloud">{snapshot.remotes.length === 0 ? t('remote.none') : t('push.detached')}</Empty>
      </DialogShell>
    );
  }
  const op: PushOp | null = remote && remoteName.trim() ? { kind: 'push', remote, branches: [{ local: name, remote: remoteName.trim(), setUpstream: track }], tags: false, force } : null;

  return (
    <DialogShell
      title={t('push.title')}
      okLabel={force ? t('push.forceOk') : t('push.ok')}
      danger={force}
      okDisabled={!op}
      preview={op}
      onOk={() => (op ? runPush(op) : undefined)}
    >
      <Field label={t('remote.remote')}>
        <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: `${r.name}  ${r.pushUrl ?? r.fetchUrl ?? ''}` }))} />
      </Field>
      <Field label={t('push.local')}>
        <span className="readonly mono">{name}</span>
      </Field>
      <Field label={t('push.remoteName')}>
        <input className="input" value={remoteName} onChange={(e) => setRemoteName(e.target.value)} />
      </Field>
      <Checkbox checked={track} onChange={setTrack} label={t('push.setUpstream')} />
      <Checkbox checked={force} onChange={setForce} label={forceMode === 'force' ? t('push.forcePlain') : t('push.forceLease')} />
      {force && <Warning danger>{t('push.forceWarning')}</Warning>}
    </DialogShell>
  );
}

interface PushRow {
  local: string;
  remote: string;
  checked: boolean;
  track: boolean;
}

/** Push several branches (and tags) together. By default, selects the branches that have unpushed commits */
export function PushBranchesDialog() {
  const { snapshot, upstreamRemote } = useRemotes();
  const forceMode = useStore((s) => s.config?.forcePushMode ?? 'withLease');
  const [remote, setRemote] = useState(upstreamRemote ?? snapshot.remotes[0]?.name ?? '');
  const locals = snapshot.refs.filter((r) => r.kind === 'head');
  const [rows, setRows] = useState<PushRow[]>(() =>
    locals.map((r) => {
      const up = r.upstream && r.upstream.startsWith(remote + '/') ? r.upstream.slice(remote.length + 1) : undefined;
      return { local: r.name, remote: up ?? r.name, checked: !!up && (r.ahead ?? 0) > 0, track: !r.upstream };
    }),
  );
  const [tags, setTags] = useState(false);
  const [force, setForce] = useState(false);

  if (snapshot.remotes.length === 0) {
    return (
      <DialogShell title={t('pushBranches.title')}>
        <Empty icon="cloud">{t('remote.none')}</Empty>
      </DialogShell>
    );
  }
  const selected = rows.filter((r) => r.checked);
  const op: PushOp | null =
    remote && (selected.length > 0 || tags)
      ? { kind: 'push', remote, branches: selected.map((r) => ({ local: r.local, remote: r.remote, setUpstream: r.track })), tags, force }
      : null;
  const update = (i: number, patch: Partial<PushRow>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  return (
    <DialogShell
      title={t('pushBranches.title')}
      wide
      okLabel={force ? t('push.forceOk') : t('push.ok')}
      danger={force}
      okDisabled={!op}
      preview={op}
      onOk={() => (op ? runPush(op) : undefined)}
    >
      <Field label={t('remote.remote')}>
        <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: `${r.name}  ${r.pushUrl ?? r.fetchUrl ?? ''}` }))} />
      </Field>
      <div className="table push-table" role="table">
        <div className="tr th" role="row">
          <span />
          <span>{t('push.local')}</span>
          <span>{t('push.remoteName')}</span>
          <span>{t('push.track')}</span>
        </div>
        {rows.map((r, i) => (
          <div className="tr" role="row" key={r.local}>
            <input type="checkbox" checked={r.checked} onChange={(e) => update(i, { checked: e.target.checked })} aria-label={r.local} />
            <span className="mono">{r.local}</span>
            <input className="input" value={r.remote} onChange={(e) => update(i, { remote: e.target.value })} />
            <input type="checkbox" checked={r.track} onChange={(e) => update(i, { track: e.target.checked })} aria-label={t('push.track')} />
          </div>
        ))}
      </div>
      <Checkbox checked={tags} onChange={setTags} label={t('push.tags')} />
      <Checkbox checked={force} onChange={setForce} label={forceMode === 'force' ? t('push.forcePlain') : t('push.forceLease')} />
      {force && <Warning danger>{t('push.forceWarning')}</Warning>}
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
