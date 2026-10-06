import type {
  ChangeKind,
  ChangedFile,
  DiffTarget,
  FileDiff,
  HostEvent,
  LogQuery,
  LogRow,
  OpResult,
  Operation,
  StatusFile,
  UiAction,
  ViewKind,
} from '../../../shared/protocol';
import { createLaneState, layoutRows, type GraphRow } from '../graph/layout';
import { opTitle, setLang, t } from '../i18n';
import { RpcError, isCancelled, type RpcClient } from '../rpc/RpcClient';
import { UNCOMMITTED, shortSha } from '../util/format';
import { DEFAULT_UI, get, set, type Boot, type DialogKind, type FsGroup, type TwiglineState, type Toast, type UiLayout } from './store';

// ---------------------------------------------------------------------------
// RPC entry points
// ---------------------------------------------------------------------------

let rpc: RpcClient;
export function setRpc(c: RpcClient): void {
  rpc = c;
}
export function getRpc(): RpcClient {
  return rpc;
}
const repo = () => get().boot.repo;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export async function bootstrap(boot: Boot): Promise<void> {
  set({ boot });
  rpc.transport.setState({ root: boot.root });
  rpc.onEvent(onHostEvent);
  const init = await rpc.request('app/init', { repo: boot.repo });
  setLang(boot.lang ?? init.language);
  const savedUi = (init.uiState.ui ?? {}) as Partial<UiLayout>;
  const ui: UiLayout = {
    ...DEFAULT_UI,
    fileView: init.config.fileStatusView,
    fsLayout: init.config.fileStatusLayout,
    ...savedUi,
    cols: { ...DEFAULT_UI.cols, ...(savedUi.cols ?? {}) },
    collapsed: { ...(savedUi.collapsed ?? {}) },
  };
  const query: LogQuery = {
    branches: init.config.historyBranches,
    includeRemotes: init.config.showRemoteBranches,
    includeStashes: init.config.showStashes,
    order: init.config.historyOrder,
  };
  if (init.initialPath) {
    query.path = init.initialPath;
    query.follow = true;
  }
  set({
    init,
    config: init.config,
    ui,
    query,
    view: init.initialView ?? 'history',
    diffOpts: { context: init.config.contextLines, ignoreWhitespace: init.config.ignoreWhitespace },
  });
  // Fetch snapshot and status in parallel, and when both are in, fetch the first page of history
  await Promise.all([loadSnapshot(), loadStatus()]);
  // PRs are over the network, so do not wait for them
  void loadPullRequests();
  watchPullRequests();
  if (!init.initialView && !init.initialPath) {
    // If there are uncommitted changes when opened, show the changes first (reviewing is the main job)
    set({ view: uncommittedCount(get()) > 0 ? 'fileStatus' : 'history' });
  }
  set({ booted: true });
  await reloadLog();
  if (get().view === 'fileStatus') {
    void loadCommitInfo();
    selectFirstFsFile();
  }
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

export async function loadSnapshot(): Promise<void> {
  try {
    const snapshot = await rpc.request('repo/snapshot', { repo: repo() });
    set({ snapshot });
  } catch (e) {
    reportError(e);
  }
}

let prGen = 0;

/** Read the PRs linked to branches. The host caches them for a short time, so it is fine to call this freely unless force is set. A failure shows no dialog */
export async function loadPullRequests(force = false): Promise<void> {
  const gen = ++prGen;
  try {
    const pullRequests = await rpc.request('pr/list', { repo: repo(), force });
    if (gen === prGen) set({ pullRequests });
  } catch (e) {
    if (gen !== prGen || isCancelled(e)) return;
    set({ pullRequests: { status: 'error', message: e instanceof Error ? e.message : String(e), byRef: get().pullRequests?.byRef ?? {} } });
  }
}

/** Creating or merging a PR in the browser does not arrive as a Git change, so re-read when returning to the panel and every few minutes while it is visible */
let prWatching = false;
function watchPullRequests(): void {
  if (prWatching || typeof window === 'undefined') return;
  prWatching = true;
  window.addEventListener('focus', () => void loadPullRequests());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void loadPullRequests();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void loadPullRequests();
  }, 180_000);
}

export async function loadStatus(): Promise<void> {
  try {
    const status = await rpc.request('status/get', { repo: repo() });
    set({ status });
    reconcileFsSelection();
    const show = computeShowUncommitted(get());
    if (show !== get().showUncommitted) {
      recomputeGraph();
      const s = get();
      if (!show && s.selected.length === 1 && s.selected[0] === UNCOMMITTED) {
        const head = s.snapshot?.head.sha ?? s.rows[0]?.sha;
        if (head) selectRow(head, {});
      }
    }
  } catch (e) {
    reportError(e);
  }
}

function computeShowUncommitted(s: TwiglineState): boolean {
  const st = s.status;
  if (!st || !s.snapshot?.head.sha) return false;
  if (s.query.search?.text || s.query.path) return false;
  if (typeof s.query.branches === 'object') return false;
  return st.staged.length + st.unstaged.length + st.conflicted.length > 0;
}

export function uncommittedCount(s: TwiglineState): number {
  const st = s.status;
  if (!st) return 0;
  return new Set([...st.staged, ...st.unstaged, ...st.conflicted].map((f) => f.path)).size;
}

/** Whether to expand the commit box. Expanded only when a commit is possible or there is a half-written message; otherwise collapsed to a one-line bar */
export function commitBoxExpanded(s: TwiglineState): boolean {
  return s.commitMsg !== '' || s.amend || (s.status?.staged.length ?? 0) > 0 || s.snapshot?.sequence?.kind === 'merge';
}

/** Whether push after commit can be chosen (there is a remote and we are on a branch) */
export function canPushAfterCommit(s: TwiglineState): boolean {
  return !!s.snapshot?.remotes.length && !!s.snapshot.head.branch;
}

/** Why the commit button cannot be pressed. null when it can */
export function commitBlockedReason(s: TwiglineState): string | null {
  if ((s.status?.conflicted.length ?? 0) > 0) return t('commit.blockedConflict');
  if ((s.status?.staged.length ?? 0) === 0 && !s.amend && s.snapshot?.sequence?.kind !== 'merge') return t('commit.blockedNothing');
  if (!s.commitMsg.trim()) return t('commit.emptyMessage');
  if (s.busy.length > 0) return t('commit.blockedBusy');
  return null;
}

/** Text of the commit button. Shows amend / push and the number of staged files so it is clear what will happen before pressing */
export function commitButtonLabel(s: TwiglineState): string {
  const push = s.pushAfter && canPushAfterCommit(s);
  const verb = s.amend ? t(push ? 'commit.amendPush' : 'commit.amendLast') : t(push ? 'commit.commitPush' : 'commit.commit');
  const staged = s.status?.staged.length ?? 0;
  return staged > 0 ? t('commit.withCount', verb, String(staged)) : verb;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

let logGen = 0;
let logCtrl: AbortController | undefined;

function isDots(q: LogQuery): boolean {
  // Search results and file history that follows renames lose the meaning of lines because commits in between are missing, so use dots only
  return !!q.search?.text.trim() || (!!q.path && q.follow === true);
}

const DOT: GraphRow = { lane: 0, color: 0, up: [], through: [], down: [], width: 1 };

function graphFor(rows: LogRow[], showUncommitted: boolean, head: string | null | undefined, dots: boolean) {
  const all: { sha: string; parents: string[] }[] = showUncommitted && head ? [{ sha: UNCOMMITTED, parents: [head] }, ...rows] : rows;
  if (dots) return { graphRows: all.map(() => DOT), laneState: createLaneState(), maxLanes: 1 };
  const laneState = createLaneState();
  const graphRows = layoutRows(laneState, all);
  let maxLanes = 1;
  for (const g of graphRows) if (g.width > maxLanes) maxLanes = g.width;
  return { graphRows, laneState, maxLanes };
}

export function recomputeGraph(): void {
  const s = get();
  const showUncommitted = computeShowUncommitted(s);
  const dots = isDots(s.query);
  set({ showUncommitted, dotsOnly: dots, ...graphFor(s.rows, showUncommitted, s.snapshot?.head.sha, dots) });
}

export async function reloadLog(opts: { keep?: boolean } = {}): Promise<void> {
  const gen = ++logGen;
  logCtrl?.abort();
  const ctrl = (logCtrl = new AbortController());
  const s = get();
  const pageSize = s.config?.pageSize ?? 500;
  const limit = Math.max(pageSize, opts.keep ? s.rows.length : 0);
  set({ logLoading: true, logError: null });
  try {
    const page = await rpc.request('log/page', { repo: repo(), query: s.query, offset: 0, limit }, ctrl.signal);
    if (gen !== logGen) return;
    const cur = get();
    const showUncommitted = computeShowUncommitted(cur);
    const dots = isDots(cur.query);
    set({
      rows: page.rows,
      cursor: page.cursor,
      logDone: page.done,
      logLoading: false,
      showUncommitted,
      dotsOnly: dots,
      ...graphFor(page.rows, showUncommitted, cur.snapshot?.head.sha, dots),
    });
    const sel = get().selected;
    if (!opts.keep) {
      // On the first display, select the first row
      const first = showUncommitted ? UNCOMMITTED : page.rows[0]?.sha;
      if (first && sel.length === 0) selectRow(first, {});
    } else if (sel.length === 1 && sel[0] === UNCOMMITTED && !showUncommitted) {
      // If the "Uncommitted Changes" row disappears (after a commit, for example), select HEAD
      const head = cur.snapshot?.head.sha ?? page.rows[0]?.sha;
      if (head) selectRow(head, {});
    } else if (sel.length > 0 && !get().detail && !get().detailLoading) {
      void loadDetail();
    }
  } catch (e) {
    if (gen !== logGen || isCancelled(e)) return;
    set({ logLoading: false, logError: e instanceof Error ? e.message : String(e) });
  }
}

export async function loadMoreLog(): Promise<void> {
  const s = get();
  if (s.logLoading || s.logDone) return;
  const gen = logGen;
  set({ logLoading: true });
  try {
    const page = await rpc.request('log/page', {
      repo: repo(),
      query: s.query,
      cursor: s.cursor ?? undefined,
      offset: s.rows.length,
      limit: s.config?.pageSize ?? 500,
    });
    if (gen !== logGen) return;
    const cur = get();
    const newGraph = cur.dotsOnly ? page.rows.map(() => DOT) : layoutRows(cur.laneState, page.rows);
    let maxLanes = cur.maxLanes;
    for (const g of newGraph) if (g.width > maxLanes) maxLanes = g.width;
    set({
      rows: cur.rows.concat(page.rows),
      graphRows: cur.graphRows.concat(newGraph),
      cursor: page.cursor,
      logDone: page.done,
      logLoading: false,
      maxLanes,
    });
  } catch (e) {
    if (gen !== logGen) return;
    set({ logLoading: false });
    if (!isCancelled(e)) reportError(e);
  }
}

export function setQuery(patch: Partial<LogQuery>): void {
  const q = { ...get().query, ...patch };
  for (const k of Object.keys(q) as (keyof LogQuery)[]) if (q[k] === undefined) delete q[k];
  set({ query: q, selected: [], anchor: null, detail: null, detailFile: null, detailDiff: null });
  void reloadLog();
}

/** Position of a SHA in display order (including virtual rows) */
let indexCache: { rows: LogRow[]; show: boolean; map: Map<string, number> } | undefined;
export function rowIndexOf(sha: string): number {
  const s = get();
  if (!indexCache || indexCache.rows !== s.rows || indexCache.show !== s.showUncommitted) {
    const map = new Map<string, number>();
    const off = s.showUncommitted ? 1 : 0;
    if (s.showUncommitted) map.set(UNCOMMITTED, 0);
    s.rows.forEach((r, i) => map.set(r.sha, i + off));
    indexCache = { rows: s.rows, show: s.showUncommitted, map };
  }
  return indexCache.map.get(sha) ?? -1;
}

export function shaAt(index: number): string | undefined {
  const s = get();
  if (s.showUncommitted) return index === 0 ? UNCOMMITTED : s.rows[index - 1]?.sha;
  return s.rows[index]?.sha;
}

export function rowAt(index: number): LogRow | undefined {
  const s = get();
  return s.showUncommitted ? (index === 0 ? undefined : s.rows[index - 1]) : s.rows[index];
}

/** Move to the row for a SHA, branch name or tag name. If it is not loaded, load pages as far as needed */
export async function jumpTo(text: string): Promise<number> {
  const s = get();
  const q = text.trim();
  if (!q) return -1;
  let sha: string | null | undefined = s.snapshot?.refs.find((r) => r.name === q || r.fullName === q)?.sha;
  if (!sha && /^[0-9a-f]{4,64}$/i.test(q)) {
    const lower = q.toLowerCase();
    sha = s.rows.find((r) => r.sha.startsWith(lower))?.sha;
  }
  if (!sha) {
    try {
      sha = await rpc.request('repo/resolve', { repo: repo(), rev: q });
    } catch {
      sha = null;
    }
  }
  if (!sha) {
    toast('warning', t('jump.notFound', q));
    return -1;
  }
  for (let i = 0; i < 400; i++) {
    const idx = rowIndexOf(sha);
    if (idx >= 0) {
      selectRow(sha, {});
      return idx;
    }
    if (get().logDone) break;
    await loadMoreLog();
    while (get().logLoading) await new Promise((r) => setTimeout(r, 30));
  }
  toast('warning', t('jump.notInHistory', shortSha(sha)));
  return -1;
}

// ---------------------------------------------------------------------------
// Selection and details
// ---------------------------------------------------------------------------

export function selectRow(sha: string, mods: { ctrl?: boolean; shift?: boolean }): void {
  const s = get();
  let selected: string[];
  let anchor = s.anchor;
  if (mods.shift && anchor) {
    const a = rowIndexOf(anchor);
    const b = rowIndexOf(sha);
    if (a >= 0 && b >= 0) {
      selected = [];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        const x = shaAt(i);
        if (x) selected.push(x);
      }
    } else selected = [sha];
  } else if (mods.ctrl) {
    selected = s.selected.includes(sha) ? s.selected.filter((x) => x !== sha) : [...s.selected, sha];
    anchor = sha;
  } else {
    selected = [sha];
    anchor = sha;
  }
  set({ selected, anchor, focusSha: sha });
  void loadDetail();
}

let detailCtrl: AbortController | undefined;

/** Details for the selection: one item shows its details; two items with Ctrl show the range diff */
export async function loadDetail(parent?: number): Promise<void> {
  detailCtrl?.abort();
  const ctrl = (detailCtrl = new AbortController());
  const s = get();
  const shas = s.selected.filter((x) => x !== UNCOMMITTED);
  if (s.selected.length === 1 && s.selected[0] === UNCOMMITTED) {
    set({ detail: null, detailFile: null, detailDiff: null, detailLoading: false });
    return;
  }
  if (shas.length === 0 || shas.length > 2) {
    set({ detail: null, detailFile: null, detailDiff: null, detailLoading: false });
    return;
  }
  let sha = shas[0];
  let compareTo: string | undefined;
  if (shas.length === 2) {
    // The newer one (the upper row) is sha, the older one is the base of the comparison
    const [a, b] = shas;
    const ia = rowIndexOf(a);
    const ib = rowIndexOf(b);
    sha = ia <= ib ? a : b;
    compareTo = ia <= ib ? b : a;
  }
  set({ detailLoading: true });
  try {
    const detail = await rpc.request('commit/detail', { repo: repo(), sha, compareTo, parent }, ctrl.signal);
    if (ctrl.signal.aborted) return;
    const prev = get().detailFile?.path;
    set({ detail, detailLoading: false });
    const file = detail.files.find((f) => f.path === prev) ?? detail.files[0];
    if (file) void selectDetailFile(file);
    else set({ detailFile: null, detailDiff: null });
  } catch (e) {
    if (isCancelled(e)) return;
    set({ detailLoading: false, detail: null });
    reportError(e);
  }
}

let diffCtrl: AbortController | undefined;

async function fetchDiff(target: DiffTarget, path: string, extra: { oldPath?: string; untracked?: boolean; full?: boolean } = {}): Promise<FileDiff | null> {
  diffCtrl?.abort();
  const ctrl = (diffCtrl = new AbortController());
  const { context, ignoreWhitespace } = get().diffOpts;
  set({ diffLoading: true });
  try {
    const diff = await rpc.request('diff/file', { repo: repo(), target, path, context, ignoreWhitespace, ...extra }, ctrl.signal);
    if (ctrl.signal.aborted) return null;
    set({ diffLoading: false });
    return diff;
  } catch (e) {
    if (isCancelled(e)) return null;
    set({ diffLoading: false });
    reportError(e);
    return null;
  }
}

export async function selectDetailFile(file: ChangedFile, full = false): Promise<void> {
  const d = get().detail;
  if (!d) return;
  set({ detailFile: file, lineSel: [], lineAnchor: null });
  const target: DiffTarget = d.compareTo ? { kind: 'range', from: d.compareTo, to: d.sha } : { kind: 'commit', sha: d.sha, parent: d.parentIndex };
  const diff = await fetchDiff(target, file.path, { oldPath: file.oldPath, full });
  if (diff && get().detailFile?.path === file.path) set({ detailDiff: diff });
}

/** Select a file of "Uncommitted Changes" in the detail pane */
export async function selectWorkingFile(group: FsGroup, path: string): Promise<void> {
  set({ wcFile: { group, path }, lineSel: [], lineAnchor: null });
  const f = findStatusFile(group, path);
  const diff = await fetchDiff(group === 'staged' ? { kind: 'index' } : { kind: 'worktree' }, path, { untracked: f?.status === '?' });
  if (diff && get().wcFile?.path === path) set({ detailDiff: diff });
}

export function findStatusFile(group: FsGroup, path: string): StatusFile | undefined {
  return get().status?.[group].find((f) => f.path === path);
}

// ---------------------------------------------------------------------------
// File status
// ---------------------------------------------------------------------------

export function selectFsFile(group: FsGroup, path: string, mods: { ctrl?: boolean; shift?: boolean } = {}): void {
  const s = get();
  const list = s.status?.[group] ?? [];
  let paths: string[];
  if (s.fsSelected?.group === group && mods.ctrl) {
    paths = s.fsSelected.paths.includes(path) ? s.fsSelected.paths.filter((p) => p !== path) : [...s.fsSelected.paths, path];
  } else if (s.fsSelected?.group === group && mods.shift && s.fsSelected.paths.length > 0) {
    const anchor = s.fsSelected.paths[0];
    const a = list.findIndex((f) => f.path === anchor);
    const b = list.findIndex((f) => f.path === path);
    paths = a >= 0 && b >= 0 ? list.slice(Math.min(a, b), Math.max(a, b) + 1).map((f) => f.path) : [path];
    if (a > b) paths.reverse();
  } else {
    paths = [path];
  }
  set({ fsSelected: { group, paths }, lineSel: [], lineAnchor: null });
  void loadFsDiff();
}

export async function loadFsDiff(full = false): Promise<void> {
  const sel = get().fsSelected;
  if (!sel || sel.paths.length !== 1) {
    set({ fsDiff: null });
    return;
  }
  const path = sel.paths[0];
  const f = findStatusFile(sel.group, path);
  if (!f) {
    set({ fsDiff: null });
    return;
  }
  const diff = await fetchDiff(sel.group === 'staged' ? { kind: 'index' } : { kind: 'worktree' }, path, { untracked: f.status === '?', full });
  const now = get().fsSelected;
  if (diff && now && now.paths.length === 1 && now.paths[0] === path && now.group === sel.group) set({ fsDiff: diff, lineSel: [] });
}

/** After the state changes, follow the selected file if it has moved to the other list */
function reconcileFsSelection(): void {
  const s = get();
  const sel = s.fsSelected;
  if (!sel || !s.status) return;
  const inGroup = (g: FsGroup, p: string) => s.status![g].some((f) => f.path === p);
  const kept = sel.paths.filter((p) => inGroup(sel.group, p));
  if (kept.length === sel.paths.length) return;
  if (kept.length > 0) {
    set({ fsSelected: { group: sel.group, paths: kept } });
    return;
  }
  const others: FsGroup[] = (['conflicted', 'unstaged', 'staged'] as FsGroup[]).filter((g) => g !== sel.group);
  for (const g of others) {
    const moved = sel.paths.filter((p) => inGroup(g, p));
    if (moved.length > 0) {
      set({ fsSelected: { group: g, paths: moved } });
      return;
    }
  }
  set({ fsSelected: null, fsDiff: null });
}

export async function stagePaths(paths: string[], action: 'stage' | 'unstage'): Promise<void> {
  if (paths.length === 0) return;
  try {
    await rpc.request('stage/paths', { repo: repo(), paths, action });
    await loadStatus();
    await refreshVisibleDiff();
  } catch (e) {
    reportError(e);
  }
}

export async function stageAll(action: 'stage' | 'unstage'): Promise<void> {
  const st = get().status;
  if (!st) return;
  const paths = action === 'stage' ? st.unstaged.map((f) => f.path) : st.staged.map((f) => f.path);
  await stagePaths(paths, action);
}

/** Line-level and hunk-level operations. Sends the diffId of the diff being shown and the line IDs */
export async function applyLines(diff: FileDiff, lineIds: number[], action: 'stage' | 'unstage' | 'discard'): Promise<void> {
  if (lineIds.length === 0) return;
  if (action === 'discard') {
    const ok = await confirm({
      title: t('confirm.discardLines.title'),
      message: t('confirm.discardLines.message', String(lineIds.length), diff.path),
      okLabel: t('discard'),
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await rpc.request('stage/lines', { repo: repo(), diffId: diff.diffId, lineIds, action });
    set({ lineSel: [], lineAnchor: null });
  } catch (e) {
    reportError(e);
  }
  await loadStatus();
  await refreshVisibleDiff();
}

export async function refreshVisibleDiff(): Promise<void> {
  const s = get();
  if (s.view === 'fileStatus') await loadFsDiff();
  else if (s.wcFile && s.selected[0] === UNCOMMITTED) {
    const still = findStatusFile(s.wcFile.group, s.wcFile.path);
    if (still) await selectWorkingFile(s.wcFile.group, s.wcFile.path);
    else set({ wcFile: null, detailDiff: null });
  }
}

export function setDiffOpts(patch: Partial<TwiglineState['diffOpts']>): void {
  set({ diffOpts: { ...get().diffOpts, ...patch } });
  const s = get();
  if (s.view === 'fileStatus') void loadFsDiff();
  else if (s.selected[0] === UNCOMMITTED) void refreshVisibleDiff();
  else if (s.detailFile) void selectDetailFile(s.detailFile);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export async function loadCommitInfo(): Promise<void> {
  try {
    const info = await rpc.request('commit/info', { repo: repo() });
    const s = get();
    set({
      commitInfo: info,
      pushAfter: info.pushAfter,
      commitMsg: s.commitMsg || (s.commitInfo ? s.commitMsg : (info.template ?? '')),
    });
  } catch (e) {
    reportError(e);
  }
}

export function setAmend(amend: boolean): void {
  const s = get();
  if (amend) set({ amend, savedMsgBeforeAmend: s.commitMsg, commitMsg: s.commitMsg.trim() ? s.commitMsg : (s.commitInfo?.lastMessage ?? '') });
  else set({ amend, commitMsg: s.savedMsgBeforeAmend ?? s.commitMsg, savedMsgBeforeAmend: null });
}

export async function commit(): Promise<void> {
  const s = get();
  const message = s.commitMsg;
  if (!message.trim()) {
    toast('warning', t('commit.emptyMessage'));
    return;
  }
  const id = addBusy(t('busy.committing'));
  try {
    const res = await rpc.request('commit/create', {
      repo: repo(),
      message,
      amend: s.amend,
      signoff: s.signoff,
      noVerify: s.noVerify,
      pushAfter: s.pushAfter,
    });
    set({ commitMsg: '', amend: false, savedMsgBeforeAmend: null });
    toast('info', res.pushed ? t('commit.doneAndPushed', shortSha(res.sha)) : t('commit.done', shortSha(res.sha)));
    void loadCommitInfo();
  } catch (e) {
    reportError(e);
  } finally {
    removeBusy(id);
  }
}

// ---------------------------------------------------------------------------
// Operations (op/run)
// ---------------------------------------------------------------------------

let opSeq = 0;
function addBusy(title: string): string {
  const id = `b${++opSeq}`;
  set({ busy: [...get().busy, { id, title }] });
  return id;
}
function removeBusy(id: string): void {
  set({ busy: get().busy.filter((b) => b.id !== id) });
}

const progress = new Map<string, { title: string; message: string; percent?: number }>();

export async function runOp(op: Operation, opts: { title?: string; success?: string } = {}): Promise<boolean> {
  return (await runOpResult(op, opts)) !== null;
}

/** runOp that returns the result (null when it failed and the error has been reported) */
export async function runOpResult(op: Operation, opts: { title?: string; success?: string } = {}): Promise<OpResult | null> {
  const id = addBusy(opts.title ?? opTitle(op.kind));
  try {
    const res = await rpc.request('op/run', { repo: repo(), op });
    if (res.stopped) {
      toast('warning', t('op.stopped'));
      setView('fileStatus');
    } else if (opts.success) {
      toast('info', opts.success);
    }
    return res;
  } catch (e) {
    reportError(e, { op });
    return null;
  } finally {
    removeBusy(id);
  }
}

export async function previewOp(op: Operation, signal?: AbortSignal): Promise<string[]> {
  const res = await rpc.request('op/run', { repo: repo(), op, dryRun: true }, signal);
  return res.commands;
}

export function uiAction(action: UiAction): void {
  rpc.request('ui/action', { repo: repo(), action }).catch((e) => reportError(e));
}

export function copyText(text: string): void {
  uiAction({ kind: 'copy', text });
  toast('info', t('copied'));
}

// ---------------------------------------------------------------------------
// Showing errors and the suggested next step
// ---------------------------------------------------------------------------

export function reportError(e: unknown, ctx: { op?: Operation } = {}): void {
  if (!(e instanceof RpcError)) {
    console.error(e);
    toast('error', e instanceof Error ? e.message : String(e));
    return;
  }
  switch (e.category) {
    case 'cancelled':
      return;
    case 'conflict':
      setView('fileStatus');
      toast('warning', t('error.conflict'));
      void loadSnapshot();
      void loadStatus();
      return;
    case 'stale':
      toast('info', t('error.stale'));
      void refreshVisibleDiff();
      return;
    case 'noUpstream':
      openDialog('push', { setUpstream: true });
      return;
    default:
      openDialog('error', { error: { category: e.category, message: e.message, stderr: e.stderr, command: e.command, files: e.files }, op: ctx.op });
  }
}

// ---------------------------------------------------------------------------
// Dialogs and toasts
// ---------------------------------------------------------------------------

export function openDialog(kind: DialogKind, props: Record<string, unknown> = {}): void {
  set({ dialog: { kind, props } });
}

export function closeDialog(): void {
  set({ dialog: null });
}

let confirmResolve: ((ok: boolean) => void) | undefined;
export function confirm(p: { title: string; message: string; okLabel?: string; danger?: boolean; detail?: string }): Promise<boolean> {
  confirmResolve?.(false);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    openDialog('confirm', p);
  });
}
export function resolveConfirm(ok: boolean): void {
  const r = confirmResolve;
  confirmResolve = undefined;
  closeDialog();
  r?.(ok);
}

let toastSeq = 0;
export function toast(kind: Toast['kind'], message: string, actions?: Toast['actions']): void {
  const id = ++toastSeq;
  set({ toasts: [...get().toasts.slice(-3), { id, kind, message, actions }] });
  setTimeout(() => dismissToast(id), kind === 'error' ? 12000 : 5000);
}

export function dismissToast(id: number): void {
  set({ toasts: get().toasts.filter((x) => x.id !== id) });
}

// ---------------------------------------------------------------------------
// Switching views and saving UI state
// ---------------------------------------------------------------------------

export function setView(view: ViewKind): void {
  if (get().view === view) return;
  set({ view });
  if (view === 'fileStatus') {
    void loadCommitInfo();
    if (!get().fsSelected) selectFirstFsFile();
    else void loadFsDiff();
  }
}

/** Move to the history search box. If it is not drawn yet, it picks this up with takeSearchFocus when drawn */
let searchFocusPending = false;
export function focusSearch(): void {
  searchFocusPending = true;
  setView('history');
  window.dispatchEvent(new Event('twigline:focus-search'));
}

export function takeSearchFocus(): boolean {
  const pending = searchFocusPending;
  searchFocusPending = false;
  return pending;
}

function selectFirstFsFile(): void {
  const st = get().status;
  if (!st) return;
  for (const g of ['conflicted', 'unstaged', 'staged'] as FsGroup[]) {
    if (st[g].length > 0) {
      selectFsFile(g, st[g][0].path);
      return;
    }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function saveUi(patch: Partial<UiLayout>): void {
  const ui = { ...get().ui, ...patch };
  set({ ui });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    rpc.request('ui/action', { repo: repo(), action: { kind: 'saveUiState', state: { ui: get().ui } } }).catch(() => undefined);
  }, 400);
}

/** shown is the state on screen (pass true for a section that has no saved value and is closed by default) */
export function toggleCollapsed(key: string, shown?: boolean): void {
  const current = shown ?? !!get().ui.collapsed[key];
  const collapsed = { ...get().ui.collapsed, [key]: !current };
  saveUi({ collapsed });
}

// ---------------------------------------------------------------------------
// Notifications from the host
// ---------------------------------------------------------------------------

let changeTimer: ReturnType<typeof setTimeout> | undefined;
const pendingKinds = new Set<ChangeKind>();

function onHostEvent(e: HostEvent): void {
  switch (e.type) {
    case 'repo/changed':
      for (const k of e.kinds) pendingKinds.add(k);
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => void applyChanges(), 30);
      return;
    case 'op/progress':
      progress.set(e.opId, { title: e.title, message: e.message, percent: e.percent });
      updateProgress();
      return;
    case 'op/finished':
      progress.delete(e.opId);
      updateProgress();
      return;
    case 'config/changed': {
      const orderChanged = e.config.historyOrder !== get().config?.historyOrder;
      const prChanged = e.config.pullRequests !== get().config?.pullRequests;
      set({ config: e.config });
      if (prChanged) void loadPullRequests(true);
      // The order is changed only through settings, not on screen
      if (orderChanged) setQuery({ order: e.config.historyOrder });
      else recomputeGraph();
      return;
    }
    case 'syntax/changed':
      void import('../syntax/highlighter').then((m) => m.onSyntaxChanged());
      return;
    case 'pr/changed':
      void loadPullRequests(true);
      return;
    case 'ui/command':
      void import('../commands').then((m) => m.handleCommand(e.command.command, e.command.context));
      return;
    case 'ui/showView':
      if (e.path) {
        setView('history');
        setQuery({ path: e.path, follow: true, search: undefined });
      } else if (e.focusSearch) {
        focusSearch();
      } else {
        setView(e.view);
      }
      return;
    case 'ui/editMessage':
      openDialog('editMessage', { requestId: e.requestId, title: e.title, initial: e.initial });
      return;
  }
}

function updateProgress(): void {
  const last = [...progress.values()].pop();
  const busy = get().busy;
  if (busy.length === 0) return;
  const top = busy[busy.length - 1];
  set({ busy: [...busy.slice(0, -1), { ...top, message: last?.message, percent: last?.percent }] });
}

async function applyChanges(): Promise<void> {
  const kinds = new Set(pendingKinds);
  pendingKinds.clear();
  const tasks: Promise<unknown>[] = [];
  const snapNeeded = ['refs', 'head', 'stash', 'sequence', 'config'].some((k) => kinds.has(k as ChangeKind));
  if (snapNeeded) tasks.push(loadSnapshot());
  if (kinds.has('status') || kinds.has('head') || kinds.has('sequence')) tasks.push(loadStatus());
  await Promise.all(tasks);
  // Fetch and push may change the state of PRs (whether to re-read is decided by the host's cache)
  if (kinds.has('refs') || kinds.has('config')) void loadPullRequests();
  if (kinds.has('refs') || kinds.has('head') || kinds.has('stash')) {
    // Re-read up to the number of loaded items, keeping the selected SHA and the scroll position
    await reloadLog({ keep: true });
    if (get().selected.length > 0 && get().selected[0] !== UNCOMMITTED) void loadDetail(get().detail?.parentIndex);
  }
  if (kinds.has('status') || kinds.has('head') || kinds.has('sequence')) await refreshVisibleDiff();
  if (kinds.has('head') && get().view === 'fileStatus') void loadCommitInfo();
}

export async function refreshAll(): Promise<void> {
  void loadPullRequests(true);
  pendingKinds.add('refs');
  pendingKinds.add('status');
  pendingKinds.add('head');
  pendingKinds.add('stash');
  pendingKinds.add('sequence');
  await applyChanges();
}
