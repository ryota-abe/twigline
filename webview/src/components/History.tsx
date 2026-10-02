import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { LogRow, RefInfo, StashInfo } from '../../../shared/protocol';
import { GraphCell, ROW_HEIGHT, graphWidth } from '../graph/GraphCell';
import type { GraphRow } from '../graph/layout';
import { branchSpan } from '../graph/span';
import { t } from '../i18n';
import { jumpTo, loadMoreLog, rowAt, rowIndexOf, saveUi, selectRow, setQuery, shaAt, takeSearchFocus, uncommittedCount } from '../store/actions';
import { displayRowCount, useStore } from '../store/store';
import { UNCOMMITTED, cx, formatDate, laneColor, shortSha } from '../util/format';
import { formatSearch, parseSearch } from '../util/search';
import { CommitDetailPane } from './CommitDetail';
import { RefBadges, useRefsBySha } from './RefBadges';
import { Sidebar } from './Sidebar';
import { Checkbox, Icon, IconButton, MenuButton, Select, Splitter, Spinner, vsContext } from './ui';

// History view

/**
 * Contents of the History tab: lists of branches, tags, stashes and so on on the left, the graph and details on the right.
 * Pressing a list item only moves around in history, so the lists are not shown in the "Uncommitted Changes" tab
 */
export function History() {
  const sidebarWidth = useStore((s) => s.ui.sidebarWidth);
  return (
    <div className="history-view" style={{ gridTemplateColumns: `${sidebarWidth}px 4px minmax(0, 1fr)` }}>
      <Sidebar />
      <Splitter direction="row" value={sidebarWidth} min={140} max={520} onChange={(v) => saveUi({ sidebarWidth: v })} />
      <CommitPane />
    </div>
  );
}

function CommitPane() {
  const detailHeight = useStore((s) => s.ui.detailHeight);
  const rootRef = useRef<HTMLDivElement>(null);
  const [maxDetail, setMaxDetail] = useState(600);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setMaxDetail(Math.max(160, el.clientHeight - 140)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="history" ref={rootRef}>
      <div className="history-list-wrap">
        <CommitList />
      </div>
      <Splitter direction="column" value={detailHeight} min={120} max={maxDetail} invert onChange={(v) => saveUi({ detailHeight: v })} />
      <div className="history-detail" style={{ height: Math.min(detailHeight, maxDetail) }}>
        <CommitDetailPane />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search and filter (placed in the one row at the top of the body)
// ---------------------------------------------------------------------------

export function HistoryFilter() {
  const query = useStore((s) => s.query);
  const [text, setText] = useState(formatSearch(query.search));
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setText(formatSearch(query.search));
  }, [query.search]);
  useEffect(() => {
    const focus = () => {
      if (!takeSearchFocus()) return;
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    focus();
    window.addEventListener('twigline:focus-search', focus);
    return () => window.removeEventListener('twigline:focus-search', focus);
  }, []);

  const runSearch = () => {
    const input = parseSearch(text);
    switch (input.kind) {
      case 'clear':
        setQuery({ search: undefined });
        return;
      case 'jump':
        setText(formatSearch(query.search));
        void jumpTo(input.rev).then((idx) => idx >= 0 && scrollToIndex(idx));
        return;
      case 'path':
        // Filter by path (renames are not followed; parents are rewritten and the graph is drawn)
        setQuery({ path: input.path, follow: false, search: undefined });
        return;
      case 'search':
        setQuery({ search: input.search });
        return;
    }
  };

  return (
    <>
      <span className={cx('search-box', query.search && 'active')}>
        <Icon name="search" />
        <input
          ref={searchRef}
          className="search"
          placeholder={t('search.placeholder')}
          title={t('search.help')}
          aria-label={t('search.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') runSearch();
            if (e.key === 'Escape') {
              setText('');
              if (query.search) setQuery({ search: undefined });
            }
          }}
          data-vscode-context='{"preventDefaultContextMenuItems":false}'
        />
        {query.search && <IconButton icon="close" title={t('search.clear')} onClick={() => setQuery({ search: undefined })} />}
      </span>
      <FilterMenu />
      {query.path && (
        <span className="chip" title={query.path}>
          <Icon name="file" />
          <span className="ellipsis">{t('history.pathChip', query.path)}</span>
          <Checkbox checked={query.follow === true} onChange={(v) => setQuery({ follow: v })} label={t('history.follow')} title={t('history.followHint')} />
          <IconButton icon="close" title={t('history.clearPath')} onClick={() => setQuery({ path: undefined, follow: undefined })} />
        </span>
      )}
    </>
  );
}

/** Branches, remote branches and stashes to show. A dot is shown when changed from the default (the setting's value) */
function FilterMenu() {
  const query = useStore((s) => s.query);
  const config = useStore((s) => s.config);
  const snapshot = useStore((s) => s.snapshot);

  const branchValue = typeof query.branches === 'object' ? `ref:${query.branches.refs[0] ?? ''}` : query.branches;
  const branchOptions = [
    { value: 'all', label: t('history.allBranches') },
    { value: 'current', label: t('history.currentBranch') },
    ...(snapshot?.refs.filter((r) => r.kind === 'head').map((r) => ({ value: `ref:${r.name}`, label: r.name })) ?? []),
  ];
  const changed =
    !!config &&
    (branchValue !== config.historyBranches || query.includeRemotes !== config.showRemoteBranches || query.includeStashes !== config.showStashes);

  return (
    <MenuButton
      icon="filter"
      title={t('history.filter')}
      label={branchValue === 'all' ? undefined : branchOptions.find((o) => o.value === branchValue)?.label}
      dot={changed}
      direction="down"
    >
      {() => (
        <>
          <label className="popup-field">
            <span>{t('history.branchesFilter')}</span>
            <Select
              value={branchValue}
              options={branchOptions}
              onChange={(v) => setQuery({ branches: v === 'all' || v === 'current' ? v : { refs: [v.slice(4)] } })}
            />
          </label>
          <Checkbox checked={query.includeRemotes} onChange={(v) => setQuery({ includeRemotes: v })} label={t('history.showRemotes')} />
          <Checkbox checked={query.includeStashes} onChange={(v) => setQuery({ includeStashes: v })} label={t('history.showStashes')} />
        </>
      )}
    </MenuButton>
  );
}

// ---------------------------------------------------------------------------
// Commit list (virtual scrolling, fixed row height of 22px)
// ---------------------------------------------------------------------------

let scrollToIndexImpl: ((i: number) => void) | undefined;
export function scrollToIndex(i: number): void {
  scrollToIndexImpl?.(i);
}

function CommitList() {
  const count = useStore(displayRowCount);
  const rows = useStore((s) => s.rows);
  const graphRows = useStore((s) => s.graphRows);
  const showUncommitted = useStore((s) => s.showUncommitted);
  const selected = useStore((s) => s.selected);
  const focusSha = useStore((s) => s.focusSha);
  const snapshot = useStore((s) => s.snapshot);
  const config = useStore((s) => s.config);
  const maxLanes = useStore((s) => s.maxLanes);
  const cols = useStore((s) => s.ui.cols);
  const dotsOnly = useStore((s) => s.dotsOnly);
  const logLoading = useStore((s) => s.logLoading);
  const logDone = useStore((s) => s.logDone);
  const logError = useStore((s) => s.logError);
  const wcCount = useStore(uncommittedCount);
  const repo = useStore((s) => s.boot.repo);
  const refsBySha = useRefsBySha(snapshot);
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });
  scrollToIndexImpl = (i: number) => virtualizer.scrollToIndex(i, { align: 'center' });

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length > 0 ? items[items.length - 1].index : 0;
  useEffect(() => {
    // Load the next page when the end gets close
    if (!logDone && !logLoading && lastIndex >= count - 60) void loadMoreLog();
  }, [lastIndex, count, logDone, logLoading]);

  const autoGraph = graphWidth(Math.min(maxLanes, 24));
  const gw = cols.graph ?? autoGraph;
  const template = `${gw}px minmax(160px, 1fr) ${cols.date}px ${cols.author}px ${cols.sha}px`;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // With one commit selected, emphasize its branch from the fork to the merge (or to the tip if unmerged)
  const span = useMemo(() => {
    if (selected.length !== 1 || selected[0] === UNCOMMITTED || dotsOnly) return undefined;
    const off = showUncommitted ? 1 : 0;
    const found = branchSpan(rows, graphRows.slice(off), selected[0], new Set(refsBySha.refs.keys()));
    return found && { from: found.from + off, to: found.to + off, color: found.color };
  }, [selected, rows, graphRows, showUncommitted, dotsOnly, refsBySha]);
  const colors = config?.graphColors ?? ['#888'];
  const headSha = snapshot?.head.sha ?? null;

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const s = useStore.getState();
      const cur = s.focusSha ? rowIndexOf(s.focusSha) : -1;
      const n = displayRowCount(s);
      let next = -1;
      const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / ROW_HEIGHT) - 1);
      if (e.key === 'ArrowDown') next = Math.min(n - 1, cur + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
      else if (e.key === 'PageDown') next = Math.min(n - 1, cur + page);
      else if (e.key === 'PageUp') next = Math.max(0, cur - page);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = n - 1;
      else return;
      e.preventDefault();
      const sha = shaAt(next);
      if (!sha) return;
      selectRow(sha, { shift: e.shiftKey });
      virtualizer.scrollToIndex(next, { align: 'auto' });
      requestAnimationFrame(() => (scrollRef.current?.querySelector(`[data-index="${next}"]`) as HTMLElement | null)?.focus());
    },
    [virtualizer],
  );

  return (
    <div className="commit-list">
      <ColumnHeader template={template} graphWidth={gw} />
      <div className="commit-scroll" ref={scrollRef} role="grid" aria-rowcount={count} aria-label={t('history.title')} onKeyDown={onKeyDown}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((vi) => {
            const index = vi.index;
            const isVirtual = showUncommitted && index === 0;
            const row = isVirtual ? undefined : rowAt(index);
            const sha = isVirtual ? UNCOMMITTED : row?.sha;
            if (!sha) return null;
            return (
              <CommitRowView
                key={sha}
                index={index}
                top={vi.start}
                template={template}
                graphWidthPx={gw}
                row={row}
                graph={graphRows[index]}
                spanColor={span && index >= span.from && index <= span.to ? span.color : undefined}
                isVirtual={isVirtual}
                wcCount={wcCount}
                selected={selectedSet.has(sha)}
                focused={focusSha === sha}
                refs={row ? refsBySha.refs.get(row.sha) : undefined}
                stash={row ? refsBySha.stashes.get(row.sha) : undefined}
                isHead={!!row && row.sha === headSha}
                detached={!!snapshot?.head.detached}
                colors={colors}
                dots={dotsOnly}
                dateFormat={config?.dateFormat ?? 'absolute'}
                repo={repo}
              />
            );
          })}
        </div>
        {count === 0 && !logLoading && <div className="list-empty">{logError ?? t('history.empty')}</div>}
      </div>
      {logLoading && (
        <div className="list-loading">
          <Spinner small /> {t('history.loading', String(rows.length))}
        </div>
      )}
    </div>
  );
}

function ColumnHeader({ template, graphWidth: gw }: { template: string; graphWidth: number }) {
  const cols = useStore((s) => s.ui.cols);
  const resize = (key: 'graph' | 'date' | 'author' | 'sha', startWidth: number, invert = false) => (e: MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const move = (ev: globalThis.MouseEvent) => {
      const w = Math.max(40, Math.min(800, startWidth + (ev.clientX - x0) * (invert ? -1 : 1)));
      saveUi({ cols: { ...useStore.getState().ui.cols, [key]: w } });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-row');
    };
    document.body.classList.add('resizing-row');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className="commit-header" style={{ gridTemplateColumns: template }} role="row">
      <div className="h" role="columnheader">
        {t('col.graph')}
        <span className="col-resize" onMouseDown={resize('graph', gw)} onDoubleClick={() => saveUi({ cols: { ...cols, graph: null } })} />
      </div>
      <div className="h" role="columnheader">
        {t('col.description')}
        <span className="col-resize" onMouseDown={resize('date', cols.date, true)} />
      </div>
      <div className="h" role="columnheader">
        {t('col.date')}
        <span className="col-resize" onMouseDown={resize('author', cols.author, true)} />
      </div>
      <div className="h" role="columnheader">
        {t('col.author')}
        <span className="col-resize" onMouseDown={resize('sha', cols.sha, true)} />
      </div>
      <div className="h" role="columnheader">
        {t('col.commit')}
      </div>
    </div>
  );
}

interface RowProps {
  index: number;
  top: number;
  template: string;
  graphWidthPx: number;
  row?: LogRow;
  graph?: GraphRow;
  spanColor?: number;
  isVirtual: boolean;
  wcCount: number;
  selected: boolean;
  focused: boolean;
  refs?: RefInfo[];
  stash?: StashInfo;
  isHead: boolean;
  detached: boolean;
  colors: string[];
  dots: boolean;
  dateFormat: string;
  repo: string;
}

/** Faint tint behind the graph cells of the emphasized branch */
function spanStyle(colors: string[], color: number): CSSProperties {
  return { background: `color-mix(in srgb, ${laneColor(colors, color)} 14%, transparent)` };
}

const CommitRowView = memo(function CommitRowView(p: RowProps) {
  const sha = p.isVirtual ? UNCOMMITTED : p.row!.sha;
  const kind = p.isVirtual ? 'uncommitted' : p.stash ? 'stash' : p.row!.parents.length > 1 ? 'merge' : 'commit';
  const context = p.isVirtual
    ? vsContext('uncommitted', { repo: p.repo })
    : vsContext(p.stash ? 'stash' : 'commit', {
        repo: p.repo,
        sha,
        twiglineIsHead: p.isHead,
        twiglineIsMerge: kind === 'merge',
        ...(p.stash ? { index: p.stash.index } : {}),
      });
  return (
    <div
      className={cx('commit-row', p.selected && 'selected', p.focused && 'focused', p.isHead && 'head', p.isVirtual && 'virtual')}
      style={{ transform: `translateY(${p.top}px)`, gridTemplateColumns: p.template }}
      role="row"
      aria-selected={p.selected}
      data-index={p.index}
      tabIndex={p.focused ? 0 : -1}
      data-vscode-context={context}
      onMouseDown={(e) => {
        if (e.button === 2) {
          // Include the right-click target in the selection (as is when several are selected)
          if (!p.selected) selectRow(sha, {});
          return;
        }
        if (e.button !== 0) return;
        selectRow(sha, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      }}
    >
      <div className="c graph" style={p.spanColor === undefined ? undefined : spanStyle(p.colors, p.spanColor)}>{p.graph && <GraphCell row={p.graph} colors={p.colors} width={p.graphWidthPx} kind={kind} isHead={p.isHead} dots={p.dots} span={p.spanColor} />}</div>
      <div className="c desc">
        {p.isVirtual ? (
          <span className="subject dim">{t('history.uncommitted', String(p.wcCount))}</span>
        ) : (
          <>
            <RefBadges refs={p.refs} stash={p.stash} detachedHead={p.isHead && p.detached} />
            <span className="subject">{p.stash ? p.stash.message : p.row!.subject}</span>
          </>
        )}
      </div>
      <div className="c mono date">{p.row ? formatDate(p.row.authorTime, p.dateFormat) : ''}</div>
      <div className="c author" title={p.row ? `${p.row.author} <${p.row.email}>` : ''}>
        {p.row?.author ?? ''}
      </div>
      <div className="c mono sha">{p.isVirtual ? '*' : shortSha(sha)}</div>
    </div>
  );
});
