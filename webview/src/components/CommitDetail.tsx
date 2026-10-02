import type { ChangedFile, CommitDetail } from '../../../shared/protocol';
import { t } from '../i18n';
import { copyText, loadDetail, saveUi, selectDetailFile, selectRow, selectWorkingFile, uiAction } from '../store/actions';
import { useStore } from '../store/store';
import { UNCOMMITTED, fullDate, shortSha } from '../util/format';
import { DiffView } from './DiffView';
import { FileList } from './FileList';
import { RefBadges, useRefsBySha } from './RefBadges';
import { Empty, IconButton, Splitter, Spinner, vsContext } from './ui';
import { WorkingFiles } from './FileStatus';

// Lower part: commit details, changed files and the diff

export function CommitDetailPane() {
  const selected = useStore((s) => s.selected);
  const detail = useStore((s) => s.detail);
  const loading = useStore((s) => s.detailLoading);
  const metaWidth = useStore((s) => s.ui.detailMetaWidth);

  let left: React.ReactNode;
  if (selected.length === 1 && selected[0] === UNCOMMITTED) {
    left = <WorkingFiles compact />;
  } else if (selected.filter((x) => x !== UNCOMMITTED).length > 2) {
    left = <Empty icon="list-selection">{t('detail.multi', String(selected.length))}</Empty>;
  } else if (detail) {
    left = <CommitMeta detail={detail} />;
  } else if (loading) {
    left = (
      <Empty>
        <Spinner />
      </Empty>
    );
  } else {
    left = <Empty icon="git-commit">{t('detail.none')}</Empty>;
  }

  return (
    <div className="detail" style={{ gridTemplateColumns: `${metaWidth}px 4px 1fr` }}>
      <div className="detail-meta">{left}</div>
      <Splitter direction="row" value={metaWidth} min={220} max={900} onChange={(v) => saveUi({ detailMetaWidth: v })} />
      <div className="detail-diff">
        <DetailDiff />
      </div>
    </div>
  );
}

function DetailDiff() {
  const diff = useStore((s) => s.detailDiff);
  const selected = useStore((s) => s.selected);
  const detailFile = useStore((s) => s.detailFile);
  const wcFile = useStore((s) => s.wcFile);
  const isWc = selected.length === 1 && selected[0] === UNCOMMITTED;
  const current = isWc ? wcFile?.path : detailFile?.path;
  if (!diff || diff.path !== current) return <Empty icon="diff">{t('diff.none')}</Empty>;
  return (
    <DiffView
      diff={diff}
      onShowAll={() => {
        if (isWc && wcFile) void selectWorkingFile(wcFile.group, wcFile.path);
        else if (detailFile) void selectDetailFile(detailFile, true);
      }}
    />
  );
}

function CommitMeta({ detail }: { detail: CommitDetail }) {
  const snapshot = useStore((s) => s.snapshot);
  const repo = useStore((s) => s.boot.repo);
  const detailFile = useStore((s) => s.detailFile);
  const refs = useRefsBySha(snapshot);
  const [subject, ...bodyLines] = detail.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const isStash = refs.stashes.has(detail.sha);

  const fileContext = (f: ChangedFile) =>
    vsContext('file.commit', { repo, path: f.path, sha: detail.sha, oldPath: f.oldPath ?? '', compareTo: detail.compareTo ?? '', parent: detail.parentIndex });

  return (
    <div className="meta">
      <div className="meta-head">
        {detail.compareTo ? (
          <div className="msg">{t('detail.compare', shortSha(detail.compareTo), shortSha(detail.sha))}</div>
        ) : (
          <>
            <div className="msg" title={detail.message}>
              {subject}
            </div>
            {body && <pre className="msg-body">{body}</pre>}
          </>
        )}
        <dl>
          <dt>{t('detail.commit')}</dt>
          <dd className="mono">
            <span className="link" onClick={() => copyText(detail.sha)} title={t('detail.copySha')}>
              {detail.sha.slice(0, 16)}…
            </span>
            <RefBadges refs={refs.refs.get(detail.sha)} stash={refs.stashes.get(detail.sha)} />
          </dd>
          {detail.parents.length > 0 && !detail.compareTo && (
            <>
              <dt>{t('detail.parents')}</dt>
              <dd className="mono">
                {detail.parents.map((p, i) => (
                  <span key={p} className="parent">
                    <span className="link" onClick={() => selectRow(p, {})}>
                      {shortSha(p)}
                    </span>
                    {detail.parents.length > 1 && !isStash && (
                      <button
                        type="button"
                        className={i === detail.parentIndex ? 'pill on' : 'pill'}
                        onClick={() => void loadDetail(i)}
                        title={t('detail.diffAgainstParent', String(i + 1))}
                      >
                        {t('detail.parentN', String(i + 1))}
                      </button>
                    )}
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt>{t('detail.author')}</dt>
          <dd>
            {detail.author} &lt;{detail.email}&gt;
          </dd>
          <dt>{t('detail.date')}</dt>
          <dd className="mono">{fullDate(detail.authorTime)}</dd>
          {(detail.committer !== detail.author || detail.committerEmail !== detail.email) && (
            <>
              <dt>{t('detail.committer')}</dt>
              <dd>
                {detail.committer} &lt;{detail.committerEmail}&gt; <span className="dim mono">{fullDate(detail.commitTime)}</span>
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="meta-files">
        <div className="files-head">
          <span>{t('detail.files', String(detail.files.length))}</span>
          <FileViewToggle />
        </div>
        <FileList
          files={detail.files}
          selectedPaths={detailFile ? [detailFile.path] : []}
          contextFor={fileContext}
          onSelect={(f) => void selectDetailFile(f)}
          onOpen={(f) =>
            uiAction({
              kind: 'openDiff',
              target: detail.compareTo ? { kind: 'range', from: detail.compareTo, to: detail.sha } : { kind: 'commit', sha: detail.sha, parent: detail.parentIndex },
              path: f.path,
              oldPath: f.oldPath,
            })
          }
          showStats
        />
      </div>
    </div>
  );
}

export function FileViewToggle() {
  const view = useStore((s) => s.ui.fileView);
  return (
    <span className="toggle">
      <IconButton icon="list-flat" title={t('files.list')} className={view === 'list' ? 'on' : ''} onClick={() => saveUi({ fileView: 'list' })} />
      <IconButton icon="list-tree" title={t('files.tree')} className={view === 'tree' ? 'on' : ''} onClick={() => saveUi({ fileView: 'tree' })} />
    </span>
  );
}
