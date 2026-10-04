import { useMemo, useState } from 'react';
import type { Operation, RpcError as RpcErrorShape } from '../../../../shared/protocol';
import { t } from '../../i18n';
import { closeDialog, confirm, getRpc, openDialog, resolveConfirm, runOp, uiAction } from '../../store/actions';
import { get, useStore } from '../../store/store';
import { basename, dirname, shortSha } from '../../util/format';
import { Button, Checkbox, Icon, Select } from '../ui';
import { initialStart, startOptions } from './BranchDialogs';
import { DialogShell, Field, Warning, useRefNameValidation } from './Dialog';

// Tags, stash, discard, confirmations, errors, repository settings

/** A tag can be put on HEAD, a ref such as a branch, or the right-clicked commit */
export function TagDialog({ sha }: { sha?: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const tags = useMemo(() => snapshot.refs.filter((r) => r.kind === 'tag').map((r) => r.name), [snapshot]);
  const [name, setName] = useState('');
  const [start, setStart] = useState(initialStart(snapshot, sha));
  const starts = startOptions(snapshot, t('tag.head', shortSha(snapshot.head.sha ?? '')), sha);
  const [annotated, setAnnotated] = useState(false);
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(false);
  const [remote, setRemote] = useState(snapshot.remotes[0]?.name ?? '');
  const validation = useRefNameValidation(name, tags);
  // tag/create takes the SHA of a commit, so turn the chosen ref into the commit it points to
  const target = start === 'HEAD' ? snapshot.head.sha : (snapshot.refs.find((r) => r.name === start)?.sha ?? start);
  const op: Operation | null =
    validation.valid && target && (!annotated || message.trim())
      ? { kind: 'tag/create', name: name.trim(), sha: target, message: annotated ? message : undefined, pushTo: push && remote ? remote : undefined }
      : null;
  return (
    <DialogShell
      title={t('tag.title')}
      okLabel={t('tag.ok')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('tag.done', name.trim()) });
      }}
    >
      <Field label={t('tag.name')} error={name.trim() ? validation.message : undefined}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="v1.2.0" />
      </Field>
      <Field label={t('tag.target')}>
        <Select value={start} onChange={setStart} options={starts} />
      </Field>
      <Checkbox checked={annotated} onChange={setAnnotated} label={t('tag.annotated')} />
      {annotated && <textarea className="input textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder={t('tag.message')} rows={4} />}
      {snapshot.remotes.length > 0 && (
        <span className="row">
          <Checkbox checked={push} onChange={setPush} label={t('tag.push')} />
          {push && <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: r.name }))} />}
        </span>
      )}
    </DialogShell>
  );
}

export function TagDeleteDialog({ name }: { name: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const [remote, setRemote] = useState('');
  const op: Operation = { kind: 'tag/delete', name, remote: remote || undefined };
  return (
    <DialogShell
      title={t('tagDelete.title')}
      okLabel={t('delete')}
      danger
      preview={op}
      onOk={async () => {
        closeDialog();
        await runOp(op);
      }}
    >
      <p>{t('tagDelete.message', name)}</p>
      {snapshot.remotes.length > 0 && (
        <Field label={t('tagDelete.remote')}>
          <Select value={remote} onChange={setRemote} options={[{ value: '', label: t('tagDelete.localOnly') }, ...snapshot.remotes.map((r) => ({ value: r.name, label: r.name }))]} />
        </Field>
      )}
    </DialogShell>
  );
}

export function TagPushDialog({ name }: { name: string }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const [remote, setRemote] = useState(snapshot.remotes[0]?.name ?? '');
  const op: Operation | null = remote ? { kind: 'tag/push', name, remote } : null;
  return (
    <DialogShell
      title={t('tagPush.title', name)}
      okLabel={t('push.ok')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('push.done') });
      }}
    >
      <Field label={t('remote.remote')}>
        <Select value={remote} onChange={setRemote} options={snapshot.remotes.map((r) => ({ value: r.name, label: r.name }))} />
      </Field>
    </DialogShell>
  );
}

export function StashDialog() {
  const features = useStore((s) => s.snapshot?.features);
  const [message, setMessage] = useState('');
  const [keepIndex, setKeepIndex] = useState(false);
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [stagedOnly, setStagedOnly] = useState(false);
  const op: Operation = { kind: 'stash/push', message: message.trim() || undefined, keepIndex, includeUntracked, stagedOnly };
  return (
    <DialogShell
      title={t('stash.title')}
      okLabel={t('stash.ok')}
      preview={op}
      onOk={async () => {
        closeDialog();
        await runOp(op, { success: t('stash.done') });
      }}
    >
      <Field label={t('stash.message')}>
        <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} />
      </Field>
      <Checkbox checked={keepIndex} onChange={setKeepIndex} label={t('stash.keepIndex')} disabled={stagedOnly} />
      <Checkbox checked={includeUntracked} onChange={setIncludeUntracked} label={t('stash.untracked')} disabled={stagedOnly} />
      {features?.stashStaged && <Checkbox checked={stagedOnly} onChange={setStagedOnly} label={t('stash.stagedOnly')} />}
    </DialogShell>
  );
}

export function StashApplyDialog({ index }: { index: number }) {
  const stash = useStore((s) => s.snapshot?.stashes.find((x) => x.index === index));
  const [restoreIndex, setRestoreIndex] = useState(false);
  const [drop, setDrop] = useState(false);
  const op: Operation = { kind: 'stash/apply', index, drop, restoreIndex };
  return (
    <DialogShell
      title={t('stashApply.title')}
      okLabel={t('stashApply.ok')}
      preview={op}
      onOk={async () => {
        closeDialog();
        await runOp(op);
      }}
    >
      <p className="mono">{`stash@{${index}}: ${stash?.message ?? ''}`}</p>
      <Checkbox checked={restoreIndex} onChange={setRestoreIndex} label={t('stashApply.index')} />
      <Checkbox checked={drop} onChange={setDrop} label={t('stashApply.drop')} />
    </DialogShell>
  );
}

export function StashBranchDialog({ index }: { index: number }) {
  const snapshot = useStore((s) => s.snapshot)!;
  const existing = useMemo(() => snapshot.refs.filter((r) => r.kind === 'head').map((r) => r.name), [snapshot]);
  const [name, setName] = useState('');
  const validation = useRefNameValidation(name, existing);
  const op: Operation | null = validation.valid ? { kind: 'stash/branch', index, name: name.trim() } : null;
  return (
    <DialogShell
      title={t('stashBranch.title', String(index))}
      okLabel={t('branch.create')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op);
      }}
    >
      <Field label={t('branch.name')} error={name.trim() ? validation.message : undefined}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
    </DialogShell>
  );
}

/** Discard. Untracked files are moved to the OS trash */
export function DiscardDialog({ paths }: { paths?: string[] }) {
  const status = useStore((s) => s.status);
  const files = status?.unstaged ?? [];
  const [picked, setPicked] = useState<Set<string>>(new Set(paths && paths.length > 0 ? paths : files.map((f) => f.path)));
  const chosen = files.filter((f) => picked.has(f.path));
  const op: Operation | null =
    chosen.length > 0
      ? { kind: 'discard', paths: chosen.filter((f) => f.status !== '?').map((f) => f.path), untracked: chosen.filter((f) => f.status === '?').map((f) => f.path) }
      : null;
  return (
    <DialogShell
      title={t('discard.title')}
      okLabel={t('discard')}
      danger
      okDisabled={!op}
      preview={op}
      wide
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op, { success: t('discard.done', String(chosen.length)) });
      }}
    >
      <Warning danger>{t('discard.warning', String(chosen.length))}</Warning>
      <div className="check-list tall">
        {files.length === 0 && <div className="dim">{t('fs.nothingUnstaged')}</div>}
        {files.map((f) => (
          <Checkbox
            key={f.path}
            checked={picked.has(f.path)}
            onChange={(v) => {
              const next = new Set(picked);
              if (v) next.add(f.path);
              else next.delete(f.path);
              setPicked(next);
            }}
            label={
              <>
                <span className={`st st-${f.status === '?' ? 'u' : f.status.toLowerCase()}`}>{f.status}</span> <span className="mono">{f.path}</span>
                {f.status === '?' && <span className="dim"> {t('discard.toTrash')}</span>}
              </>
            }
          />
        ))}
      </div>
      <span className="row">
        <Button small onClick={() => setPicked(new Set(files.map((f) => f.path)))}>
          {t('selectAll')}
        </Button>
        <Button small onClick={() => setPicked(new Set())}>
          {t('selectNone')}
        </Button>
      </span>
    </DialogShell>
  );
}

export function IgnoreDialog({ path }: { path: string }) {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  const dir = dirname(path);
  const choices = [
    { value: `/${path}`, label: t('ignore.file', path) },
    ...(ext ? [{ value: `*${ext}`, label: t('ignore.ext', ext) }] : []),
    ...(dir ? [{ value: `/${dir}/`, label: t('ignore.dir', dir) }] : []),
  ];
  const [pattern, setPattern] = useState(choices[0].value);
  const op: Operation | null = pattern.trim() ? { kind: 'gitignore/add', pattern: pattern.trim() } : null;
  return (
    <DialogShell
      title={t('ignore.title')}
      okLabel={t('ignore.ok')}
      okDisabled={!op}
      preview={op}
      onOk={async () => {
        closeDialog();
        if (op) await runOp(op);
      }}
    >
      {choices.map((c) => (
        <label key={c.value} className="radio block">
          <input type="radio" checked={pattern === c.value} onChange={() => setPattern(c.value)} />
          {c.label}
        </label>
      ))}
      <Field label={t('ignore.pattern')}>
        <input className="input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
      </Field>
    </DialogShell>
  );
}

export function ConfirmDialog({ title, message, okLabel, danger, detail }: { title: string; message: string; okLabel?: string; danger?: boolean; detail?: string }) {
  return (
    <DialogShell title={title} okLabel={okLabel ?? t('ok')} danger={danger} onOk={() => resolveConfirm(true)} onCancel={() => resolveConfirm(false)}>
      <p className="pre">{message}</p>
      {detail && <pre className="detail-pre">{detail}</pre>}
    </DialogShell>
  );
}

/** Showing errors and the suggested next step */
export function ErrorDialog({ error, op }: { error: RpcErrorShape; op?: Operation }) {
  const [showDetail, setShowDetail] = useState(false);
  const retry = op
    ? () => {
        closeDialog();
        void runOp(op);
      }
    : undefined;
  let body: React.ReactNode = null;
  const actions: React.ReactNode[] = [];
  switch (error.category) {
    case 'dirtyWorktree':
      body = (
        <>
          <p>{t('error.dirty')}</p>
          {error.files && error.files.length > 0 && (
            <ul className="file-bullets">
              {error.files.slice(0, 20).map((f) => (
                <li key={f} className="mono">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </>
      );
      if (op)
        actions.push(
          <Button
            key="stash"
            primary
            onClick={async () => {
              closeDialog();
              const untracked = /untracked/i.test(error.stderr ?? '');
              const ok = await runOp({ kind: 'stash/push', message: `Twigline: ${t('error.autoStash')}`, keepIndex: false, includeUntracked: untracked, stagedOnly: false });
              if (ok) await runOp(op, { success: t('error.stashedAndDone') });
            }}
          >
            {t('error.stashAndContinue')}
          </Button>,
        );
      break;
    case 'rejected':
      if (op?.kind === 'pull' && op.into) {
        // A branch that is not checked out has diverged from the remote and cannot be fast-forwarded
        const into = op.into;
        body = <p>{t('error.pullIntoRejected', into)}</p>;
        actions.push(
          <Button
            key="checkout"
            primary
            onClick={async () => {
              closeDialog();
              await runOp({ kind: 'checkout', ref: into }, { success: t('cmd.checkedOut', into) });
            }}
          >
            {t('checkout.ok')}
          </Button>,
        );
        break;
      }
      body = <p>{t('error.rejected')}</p>;
      if (op?.kind === 'push') {
        // The refs are as of the last fetch, so the push dialog cannot tell what the remote has until it is fetched.
        // After the fetch it shows how far the remote is ahead and whether a force push is needed
        const push = op;
        actions.push(
          <Button
            key="review"
            onClick={async () => {
              closeDialog();
              if (!(await runOp({ kind: 'fetch', remote: push.remote, prune: false, tags: false }))) return;
              if (push.branches.length === 1) openDialog('push', { branch: push.branches[0].local });
              else openDialog('pushBranches');
            }}
          >
            {t('error.fetchAndReview')}
          </Button>,
        );
      }
      actions.push(
        <Button key="pull" primary onClick={() => openDialog('pull')}>
          {t('pull.open')}
        </Button>,
      );
      break;
    case 'auth':
      body = <p className="pre">{t('error.auth')}</p>;
      break;
    case 'locked':
      body = <p>{t('error.locked')}</p>;
      actions.push(
        <Button
          key="lock"
          danger
          onClick={() => {
            closeDialog();
            uiAction({ kind: 'removeLock' });
          }}
        >
          {t('error.removeLock')}
        </Button>,
      );
      break;
    case 'network':
      body = <p>{t('error.network')}</p>;
      if (retry)
        actions.push(
          <Button key="retry" primary onClick={retry}>
            {t('error.retry')}
          </Button>,
        );
      break;
    default:
      body = null;
  }
  return (
    <DialogShell
      title={t('error.title')}
      cancelLabel={t('close')}
      footerExtra={
        <>
          <Button small onClick={() => uiAction({ kind: 'showOutput' })}>
            {t('error.showOutput')}
          </Button>
          {actions}
        </>
      }
    >
      <div className="error-msg">
        <Icon name="error" />
        <span className="pre">{error.message}</span>
      </div>
      {body}
      {(error.stderr || error.command) && (
        <>
          <button type="button" className="link-btn" onClick={() => setShowDetail(!showDetail)}>
            {showDetail ? t('error.hideDetail') : t('error.showDetail')}
          </button>
          {showDetail && (
            <pre className="detail-pre">
              {error.command ? `$ ${error.command}\n` : ''}
              {error.stderr}
            </pre>
          )}
        </>
      )}
    </DialogShell>
  );
}

/** Editing a message git asked for, such as for squash in an interactive rebase */
export function EditMessageDialog({ requestId, title, initial }: { requestId: string; title: string; initial: string }) {
  const [text, setText] = useState(initial);
  const reply = (message: string | null) => {
    closeDialog();
    void getRpc().request('ui/editMessageReply', { requestId, message });
  };
  return (
    <DialogShell title={title === 'Combined commit message' ? t('editMessage.squash') : t('editMessage.reword')} okLabel={t('ok')} onOk={() => reply(text)} onCancel={() => reply(null)} wide>
      <textarea className="input textarea tall" value={text} onChange={(e) => setText(e.target.value)} rows={12} />
    </DialogShell>
  );
}

/** Repository settings: add, edit and delete remotes, user.name / user.email of this repository, .gitignore */
export function SettingsDialog() {
  const snapshot = useStore((s) => s.snapshot)!;
  const [name, setName] = useState(snapshot.user.name ?? '');
  const [email, setEmail] = useState(snapshot.user.email ?? '');
  const [editing, setEditing] = useState<{ original?: string; name: string; url: string } | null>(null);
  return (
    <DialogShell title={t('settings.title')} wide cancelLabel={t('close')}>
      <h4>{t('settings.remotes')}</h4>
      <div className="table remotes-table">
        {snapshot.remotes.map((r) => (
          <div className="tr" key={r.name}>
            <span className="mono">{r.name}</span>
            <span className="mono dim ellipsis">{r.fetchUrl}</span>
            <span className="row">
              <Button small onClick={() => setEditing({ original: r.name, name: r.name, url: r.fetchUrl ?? '' })}>
                {t('edit')}
              </Button>
              <Button
                small
                danger
                onClick={async () => {
                  const ok = await confirm({ title: t('settings.removeRemoteTitle'), message: t('settings.removeRemote', r.name), okLabel: t('delete'), danger: true });
                  if (ok) {
                    await runOp({ kind: 'remote/remove', name: r.name });
                    openDialog('settings');
                  } else openDialog('settings');
                }}
              >
                {t('settings.removeRemoteButton')}
              </Button>
            </span>
          </div>
        ))}
      </div>
      {editing ? (
        <div className="inline-form">
          <input className="input" placeholder={t('settings.remoteName')} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          <input className="input grow" placeholder="https://…" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} />
          <Button
            small
            primary
            disabled={!editing.name.trim() || !editing.url.trim()}
            onClick={async () => {
              const op: Operation = editing.original
                ? { kind: 'remote/edit', name: editing.original, newName: editing.name.trim(), url: editing.url.trim() }
                : { kind: 'remote/add', name: editing.name.trim(), url: editing.url.trim() };
              if (await runOp(op)) setEditing(null);
            }}
          >
            {t('save')}
          </Button>
          <Button small onClick={() => setEditing(null)}>
            {t('cancel')}
          </Button>
        </div>
      ) : (
        <Button small icon="add" onClick={() => setEditing({ name: snapshot.remotes.length === 0 ? 'origin' : '', url: '' })}>
          {t('settings.addRemote')}
        </Button>
      )}
      <h4>{t('settings.identity')}</h4>
      <Field label="user.name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="user.email">
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Button small onClick={() => void runOp({ kind: 'config/user', name: name.trim(), email: email.trim() }, { success: t('settings.saved') })}>
        {t('settings.saveIdentity')}
      </Button>
      <h4>{t('settings.other')}</h4>
      <span className="row wrap">
        <Button small icon="file" onClick={() => uiAction({ kind: 'openGitignore' })}>
          {t('settings.gitignore')}
        </Button>
        <Button small icon="rocket" onClick={() => uiAction({ kind: 'optimize' })}>
          {t('settings.optimize')}
        </Button>
        <Button small icon="settings-gear" onClick={() => uiAction({ kind: 'openSettings' })}>
          {t('settings.vscode')}
        </Button>
      </span>
      <p className="dim">
        git {snapshot.gitVersion} ・ {snapshot.objectFormat.toUpperCase()} ・ {get().boot.root}
      </p>
    </DialogShell>
  );
}
