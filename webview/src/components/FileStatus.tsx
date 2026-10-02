import type { StatusFile } from '../../../shared/protocol';
import { t } from '../i18n';
import {
  canPushAfterCommit,
  commit,
  commitBlockedReason,
  commitBoxExpanded,
  commitButtonLabel,
  loadFsDiff,
  openDialog,
  runOp,
  saveUi,
  selectFsFile,
  selectWorkingFile,
  setAmend,
  stageAll,
  stagePaths,
  uiAction,
} from '../store/actions';
import { set as setStore, useStore, type FsGroup } from '../store/store';
import { cx } from '../util/format';
import { FileViewToggle } from './CommitDetail';
import { DiffView } from './DiffView';
import { FileList } from './FileList';
import { Button, Checkbox, Empty, Icon, IconButton, MenuButton, Splitter, vsContext } from './ui';

// File status view

export function FileStatus() {
  const listWidth = useStore((s) => s.ui.fsListWidth);
  const commitHeight = useStore((s) => s.ui.commitHeight);
  const fsDiff = useStore((s) => s.fsDiff);
  const fsSelected = useStore((s) => s.fsSelected);
  const expanded = useStore(commitBoxExpanded);

  return (
    <div
      className="file-status"
      style={{ gridTemplateColumns: `${listWidth}px 4px 1fr`, gridTemplateRows: expanded ? `1fr 4px ${commitHeight}px` : '1fr auto' }}
    >
      <div className="fs-left">
        <WorkingFiles />
      </div>
      <Splitter direction="row" value={listWidth} min={200} max={900} onChange={(v) => saveUi({ fsListWidth: v })} />
      <div className="fs-right">
        {fsSelected?.group === 'conflicted' && <ConflictBar paths={fsSelected.paths} />}
        {fsSelected && fsSelected.paths.length > 1 ? (
          <Empty icon="files">{t('fs.multi', String(fsSelected.paths.length))}</Empty>
        ) : fsDiff && fsSelected && fsDiff.path === fsSelected.paths[0] ? (
          <DiffView diff={fsDiff} onShowAll={() => void loadFsDiff(true)} />
        ) : (
          <Empty icon="diff">{t('diff.none')}</Empty>
        )}
      </div>
      {/* The collapsed commit box has a fixed one-line height, so the height handle is shown only when it is expanded */}
      {expanded && (
        <div className="fs-split-h">
          <Splitter direction="column" value={commitHeight} min={96} max={480} invert onChange={(v) => saveUi({ commitHeight: v })} />
        </div>
      )}
      <div className="fs-commit">
        <CommitBox />
      </div>
    </div>
  );
}

/** Lists of staged, unstaged and conflicted files. compact is for the detail pane in history (uncommitted changes) */
export function WorkingFiles({ compact }: { compact?: boolean }) {
  const status = useStore((s) => s.status);
  const layout = useStore((s) => s.ui.fsLayout);
  const repo = useStore((s) => s.boot.repo);
  const fsSelected = useStore((s) => s.fsSelected);
  const wcFile = useStore((s) => s.wcFile);
  if (!status) return null;

  const selectedIn = (g: FsGroup) => {
    if (compact) return wcFile?.group === g ? [wcFile.path] : [];
    return fsSelected?.group === g ? fsSelected.paths : [];
  };
  const onSelect = (g: FsGroup) => (f: StatusFile, mods: { ctrl: boolean; shift: boolean }) => {
    if (compact) void selectWorkingFile(g, f.path);
    else selectFsFile(g, f.path, mods);
  };
  const ctx = (section: string) => (f: StatusFile) => vsContext(section, { repo, path: f.path, untracked: f.status === '?', conflict: f.conflict ?? '' });
  const open = (g: FsGroup) => (f: StatusFile) => uiAction({ kind: 'openDiff', target: g === 'staged' ? { kind: 'index' } : { kind: 'worktree' }, path: f.path });

  const conflicted = status.conflicted.length > 0 && (
    <Group title={t('fs.conflicted', String(status.conflicted.length))} icon="warning" className="conflicted">
      <FileList
        files={status.conflicted}
        selectedPaths={selectedIn('conflicted')}
        onSelect={onSelect('conflicted')}
        onOpen={(f) => uiAction({ kind: 'openMergeEditor', path: f.path })}
        contextFor={ctx('file.conflicted')}
      />
    </Group>
  );

  if (layout === 'single' && !compact) {
    // Single-list view (stage with checkboxes)
    const byPath = new Map<string, { staged?: StatusFile; unstaged?: StatusFile }>();
    for (const f of status.staged) byPath.set(f.path, { ...byPath.get(f.path), staged: f });
    for (const f of status.unstaged) byPath.set(f.path, { ...byPath.get(f.path), unstaged: f });
    const files = [...byPath.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, v]) => ({ path, status: (v.unstaged ?? v.staged)!.status, state: v }));
    return (
      <div className="fs-groups">
        {conflicted}
        <Group
          title={t('fs.changes', String(files.length))}
          actions={
            <>
              <FileViewToggle />
              <LayoutToggle />
              <DiscardButton disabled={status.unstaged.length === 0} />
            </>
          }
        >
          <FileList
            files={files}
            selectedPaths={fsSelected ? fsSelected.paths : []}
            onSelect={(f, mods) => selectFsFile(f.state.unstaged ? 'unstaged' : 'staged', f.path, mods)}
            checkbox={{
              checked: (f) => (f.state.staged && f.state.unstaged ? 'mixed' : !!f.state.staged),
              toggle: (f) => void stagePaths([f.path], f.state.unstaged ? 'stage' : 'unstage'),
            }}
            onSpace={(sel) => {
              const toStage = sel.filter((f) => f.state.unstaged).map((f) => f.path);
              if (toStage.length > 0) void stagePaths(toStage, 'stage');
              else void stagePaths(sel.map((f) => f.path), 'unstage');
            }}
            contextFor={(f) => vsContext(f.state.unstaged ? 'file.unstaged' : 'file.staged', { repo, path: f.path, untracked: f.status === '?' })}
            onOpen={(f) => uiAction({ kind: 'openDiff', target: f.state.unstaged ? { kind: 'worktree' } : { kind: 'index' }, path: f.path })}
            emptyText={t('fs.clean')}
          />
        </Group>
      </div>
    );
  }

  return (
    <div className="fs-groups">
      {conflicted}
      <Group
        title={t('fs.staged', String(status.staged.length))}
        actions={
          <>
            {!compact && (
              <>
                <FileViewToggle />
                <LayoutToggle />
              </>
            )}
            <Button small disabled={status.staged.length === 0} onClick={() => void stageAll('unstage')}>
              {t('fs.unstageAll')}
            </Button>
          </>
        }
      >
        <FileList
          files={status.staged}
          selectedPaths={selectedIn('staged')}
          onSelect={onSelect('staged')}
          onOpen={open('staged')}
          contextFor={ctx('file.staged')}
          onSpace={(sel) => void stagePaths(sel.map((f) => f.path), 'unstage')}
          rowAction={{ icon: 'remove', title: t('fs.unstageFile'), run: (f) => void stagePaths([f.path], 'unstage') }}
          drag={{ group: 'staged', onDrop: (paths) => void stagePaths(paths, 'stage') }}
          emptyText={compact ? undefined : t('fs.nothingStaged')}
        />
      </Group>
      <Group
        title={t('fs.unstaged', String(status.unstaged.length))}
        actions={
          <>
            {!compact && <DiscardButton disabled={status.unstaged.length === 0} />}
            <Button small disabled={status.unstaged.length === 0} onClick={() => void stageAll('stage')}>
              {t('fs.stageAll')}
            </Button>
          </>
        }
      >
        <FileList
          files={status.unstaged}
          selectedPaths={selectedIn('unstaged')}
          onSelect={onSelect('unstaged')}
          onOpen={open('unstaged')}
          contextFor={ctx('file.unstaged')}
          onSpace={(sel) => void stagePaths(sel.map((f) => f.path), 'stage')}
          rowAction={{ icon: 'add', title: t('fs.stageFile'), run: (f) => void stagePaths([f.path], 'stage') }}
          drag={{ group: 'unstaged', onDrop: (paths) => void stagePaths(paths, 'unstage') }}
          emptyText={compact ? undefined : t('fs.nothingUnstaged')}
        />
      </Group>
    </div>
  );
}

/** Buttons to resolve a conflicted file. Shown by meaning rather than as ours / theirs */
function ConflictBar({ paths }: { paths: string[] }) {
  const sequence = useStore((s) => s.snapshot?.sequence);
  const current = sequence?.kind === 'rebase' ? sequence.branch ?? 'HEAD' : undefined;
  return (
    <div className="conflict-bar">
      <Icon name="warning" />
      <span>{t('conflict.bar', String(paths.length))}</span>
      <span className="spacer" />
      <Button small onClick={() => void runOp({ kind: 'conflict/resolve', paths, side: 'current' })} title={current}>
        {t('conflict.useCurrent')}
      </Button>
      <Button small onClick={() => void runOp({ kind: 'conflict/resolve', paths, side: 'incoming' })}>
        {t('conflict.useIncoming')}
      </Button>
      {paths.length === 1 && (
        <Button small icon="git-merge" onClick={() => uiAction({ kind: 'openMergeEditor', path: paths[0] })}>
          {t('conflict.mergeEditor')}
        </Button>
      )}
      <Button small primary onClick={() => void runOp({ kind: 'conflict/mark', paths, resolved: true })}>
        {t('conflict.markResolved')}
      </Button>
    </div>
  );
}

/** Discard unstaged changes. Discard works only on unstaged files, so it sits in the heading of that list */
function DiscardButton({ disabled }: { disabled: boolean }) {
  return (
    <Button small disabled={disabled} onClick={() => openDialog('discard')} title={t('fs.discardTitle')}>
      {t('fs.discard')}
    </Button>
  );
}

function LayoutToggle() {
  const layout = useStore((s) => s.ui.fsLayout);
  return (
    <IconButton
      icon={layout === 'split' ? 'split-vertical' : 'checklist'}
      title={layout === 'split' ? t('fs.layoutSingle') : t('fs.layoutSplit')}
      onClick={() => saveUi({ fsLayout: layout === 'split' ? 'single' : 'split' })}
    />
  );
}

function Group({ title, actions, children, icon, className }: { title: string; actions?: React.ReactNode; children: React.ReactNode; icon?: string; className?: string }) {
  return (
    <section className={`fs-group ${className ?? ''}`}>
      <header className="fs-gh">
        {icon && <Icon name={icon} />}
        <span className="title">{title}</span>
        <span className="actions">{actions}</span>
      </header>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Commit box
// ---------------------------------------------------------------------------

// When there are no staged files and no message, collapse to one line holding only the input, amend, "...", stash and commit.
// It expands as soon as one character is typed or something is staged. The same element is used when collapsing and expanding, so focus is not lost while typing
export function CommitBox() {
  const info = useStore((s) => s.commitInfo);
  const msg = useStore((s) => s.commitMsg);
  const amend = useStore((s) => s.amend);
  const signoff = useStore((s) => s.signoff);
  const noVerify = useStore((s) => s.noVerify);
  const pushAfter = useStore((s) => s.pushAfter);
  const status = useStore((s) => s.status);
  const sequence = useStore((s) => s.snapshot?.sequence);
  const busy = useStore((s) => s.busy.length > 0);
  const snapshot = useStore((s) => s.snapshot);
  const expanded = useStore(commitBoxExpanded);
  const blocked = useStore(commitBlockedReason);
  const label = useStore(commitButtonLabel);
  const canPush = useStore(canPushAfterCommit);

  const lines = msg.split('\n');
  const subjectLen = Array.from(lines[0] ?? '').length;
  const secondLineWarn = lines.length > 1 && lines[1].trim() !== '';
  const canCommit = blocked === null;
  const pushTarget = snapshot?.head.upstream ?? (snapshot?.remotes[0] ? `${snapshot.remotes[0].name}/${snapshot.head.branch ?? ''}` : undefined);

  const author = info?.author.name;
  const authorTitle = author ? `${author} <${info?.author.email ?? ''}>` : t('commit.noAuthor');

  return (
    <div className={cx('commitbox', !expanded && 'collapsed')}>
      <div className="cm-main">
        <div className="cm-text-wrap">
          <textarea
            className="cm-text"
            value={msg}
            rows={1}
            placeholder={t('commit.placeholder')}
            onChange={(e) => setStore({ commitMsg: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (canCommit) void commit();
              }
            }}
            spellCheck={false}
            data-vscode-context='{"preventDefaultContextMenuItems":false}'
          />
        </div>
      </div>
      {/* The character count and author are placed in the action row, not over the input (so they do not overlap text that reaches the bottom edge) */}
      <div className="cm-opts">
        {expanded && (
          <span className={cx('cm-count', subjectLen > 50 && 'warn')} title={t('commit.subjectGuide')}>
            {subjectLen}/50
            {secondLineWarn && <span className="warn"> ・ {t('commit.secondLine')}</span>}
          </span>
        )}
        {expanded && (
          <Checkbox
            checked={pushAfter}
            onChange={(v) => setStore({ pushAfter: v })}
            label={pushTarget ? t('commit.pushTo', pushTarget) : t('commit.pushAfter')}
            disabled={!canPush}
          />
        )}
        <Checkbox checked={amend} onChange={setAmend} label={t('commit.amend')} disabled={!!snapshot?.head.unborn} />
        <span className="spacer" />
        {expanded && info && (
          <span className={cx('cm-author', !author && 'warn')} title={authorTitle}>
            <Icon name={author ? 'account' : 'warning'} />
            <span className="name">{author ?? t('commit.noAuthor')}</span>
          </span>
        )}
        <MenuButton icon="ellipsis" title={t('commit.more')} dot={signoff || noVerify} align="right">
          {(close) => (
            <>
              <Checkbox checked={signoff} onChange={(v) => setStore({ signoff: v })} label={t('commit.signoff')} />
              <Checkbox checked={noVerify} onChange={(v) => setStore({ noVerify: v })} label={t('commit.noVerify')} />
              {!!info?.recentMessages.length && (
                <>
                  <div className="popup-sep" />
                  <div className="popup-heading">{t('commit.history')}</div>
                  {info.recentMessages.map((m, i) => (
                    <div
                      key={i}
                      className="popup-item"
                      title={m}
                      onClick={() => {
                        setStore({ commitMsg: m });
                        close();
                      }}
                    >
                      {m.split('\n')[0]}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </MenuButton>
        {/* Stash works on both staged and unstaged files, so it sits next to commit in the commit box at the bottom of the whole tab */}
        <Button
          disabled={busy || (status?.staged.length ?? 0) + (status?.unstaged.length ?? 0) === 0}
          onClick={() => openDialog('stash')}
          title={t('fs.stashTitle')}
        >
          {t('fs.stash')}
        </Button>
        {sequence?.kind === 'merge' && (
          <Button small onClick={() => void runOp({ kind: 'sequence/control', action: 'continue', message: msg.trim() || undefined })}>
            {t('banner.commitMerge')}
          </Button>
        )}
        {/* When it cannot be pressed, the title shows the reason; when it can, the key */}
        <Button primary disabled={!canCommit} onClick={() => void commit()} title={blocked ?? 'Ctrl+Enter'}>
          {label}
        </Button>
      </div>
    </div>
  );
}
