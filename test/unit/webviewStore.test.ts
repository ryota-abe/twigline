import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwiglineConfig, LogRow, PullRequestList, RepoSnapshot, WorkingTreeStatus } from '../../shared/protocol';
import { MockHost } from '../../webview/src/rpc/MockHost';
import { RpcClient } from '../../webview/src/rpc/RpcClient';
import * as actions from '../../webview/src/store/actions';
import { DEFAULT_QUERY, DEFAULT_UI, useStore } from '../../webview/src/store/store';
import { createLaneState } from '../../webview/src/graph/layout';
import { UNCOMMITTED } from '../../webview/src/util/format';
import { formatSearch, parseSearch } from '../../webview/src/util/search';

// Verify the webview state management with MockHost (paging, the virtual "Uncommitted Changes" row, selection, change notifications)

const sha = (n: number) => n.toString(16).padStart(40, '0');
const N = 1200;
const rows: LogRow[] = Array.from({ length: N }, (_, i) => ({
  sha: sha(N - i),
  parents: N - i > 1 ? [sha(N - i - 1)] : [],
  author: 'A',
  email: 'a@example.com',
  authorTime: 1_700_000_000 - i,
  subject: `commit ${N - i}`,
}));

const config: TwiglineConfig = {
  historyOrder: 'date',
  historyBranches: 'all',
  showRemoteBranches: true,
  showStashes: false,
  pageSize: 500,
  dateFormat: 'absolute',
  graphColors: ['#000'],
  fileStatusLayout: 'split',
  fileStatusView: 'list',
  contextLines: 3,
  ignoreWhitespace: false,
  maxDiffLines: 5000,
  syntaxHighlight: true,
  forcePushMode: 'withLease',
  rememberPushAfter: true,
  pullRequests: true,
  customActions: [],
};

const snapshot: RepoSnapshot = {
  repo: 'r',
  root: '/r',
  name: 'r',
  head: { sha: sha(N), branch: 'main', detached: false, unborn: false, ahead: 0, behind: 0 },
  refs: [{ kind: 'head', name: 'main', fullName: 'refs/heads/main', sha: sha(N), isHead: true }],
  remotes: [],
  stashes: [],
  sequence: null,
  submodules: [],
  user: {},
  features: { stashStaged: true, updateRefs: true },
  gitVersion: '2.47.1',
  objectFormat: 'sha1',
};

let status: WorkingTreeStatus;
let host: MockHost;
let prs: PullRequestList | Error;

const openPr: PullRequestList = {
  status: 'ok',
  byRef: {
    'refs/heads/main': { number: 12, title: 't', url: 'https://github.com/me/repo/pull/12', state: 'open', headRef: 'main', baseRef: 'dev', updatedAt: 0 },
  },
};

beforeEach(async () => {
  status = { staged: [], unstaged: [{ path: 'a.txt', status: 'M' }], conflicted: [] };
  prs = openPr;
  useStore.setState({
    snapshot: null,
    status: null,
    rows: [],
    graphRows: [],
    laneState: createLaneState(),
    selected: [],
    anchor: null,
    detail: null,
    query: DEFAULT_QUERY,
    ui: DEFAULT_UI,
    logDone: false,
    logLoading: false,
    cursor: null,
  });
  host = new MockHost({
    'app/init': () => ({ repo: 'r', root: '/r', name: 'r', language: 'ja', platform: 'win32', config, uiState: {} }),
    'repo/snapshot': () => snapshot,
    'status/get': () => status,
    'log/page': (p) => {
      const slice = rows.slice(p.offset, p.offset + p.limit);
      const done = p.offset + slice.length >= rows.length;
      return { rows: slice, cursor: done ? null : 'cursor', done };
    },
    'commit/detail': (p) => ({
      sha: p.sha,
      parents: [],
      author: 'A',
      email: 'a@example.com',
      authorTime: 0,
      committer: 'A',
      committerEmail: 'a@example.com',
      commitTime: 0,
      message: 'm',
      files: [],
      parentIndex: 0,
    }),
    'ui/action': () => undefined,
    'pr/list': () => (prs instanceof Error ? Promise.reject({ category: 'network', message: prs.message }) : prs),
  });
  actions.setRpc(new RpcClient(host));
  await actions.bootstrap({ repo: 'r', root: '/r', lang: 'ja' });
});

describe('webview store', () => {
  it('loads the first page, shows the uncommitted row and lays out the graph', () => {
    const s = useStore.getState();
    expect(s.rows).toHaveLength(500);
    expect(s.showUncommitted).toBe(true);
    // The virtual row goes at the top as a row whose parent is HEAD, so a line is drawn to HEAD without special handling
    expect(s.graphRows).toHaveLength(501);
    expect(s.graphRows[0].down[0].to).toBe(s.graphRows[1].lane);
    expect(s.selected).toEqual([UNCOMMITTED]);
    // State that WebviewPanelSerializer uses for restoring
    expect(host.getState()).toEqual({ root: '/r' });
  });

  it('pages with the cursor and continues the lane state', async () => {
    await actions.loadMoreLog();
    await actions.loadMoreLog();
    const s = useStore.getState();
    expect(s.rows).toHaveLength(N);
    expect(s.logDone).toBe(true);
    expect(s.graphRows).toHaveLength(N + 1);
    const pages = host.calls.filter((c) => c.method === 'log/page').map((c) => c.params as { offset: number; cursor?: string });
    expect(pages.map((p) => p.offset)).toEqual([0, 500, 1000]);
    expect(pages[1].cursor).toBe('cursor');
  });

  it('selects ranges with shift and toggles with ctrl', async () => {
    actions.selectRow(sha(N - 2), {});
    actions.selectRow(sha(N - 6), { shift: true });
    expect(useStore.getState().selected).toEqual([sha(N - 2), sha(N - 3), sha(N - 4), sha(N - 5), sha(N - 6)]);
    actions.selectRow(sha(N - 10), { ctrl: true });
    expect(useStore.getState().selected).toContain(sha(N - 10));
    actions.selectRow(sha(N - 10), { ctrl: true });
    expect(useStore.getState().selected).not.toContain(sha(N - 10));
  });

  it('moves the selection to HEAD when the uncommitted row disappears', async () => {
    status = { staged: [], unstaged: [], conflicted: [] };
    host.emit({ type: 'repo/changed', repo: 'r', kinds: ['status'] });
    await vi.waitFor(() => expect(useStore.getState().showUncommitted).toBe(false));
    expect(useStore.getState().selected).toEqual([sha(N)]);
    expect(useStore.getState().graphRows).toHaveLength(500);
  });

  it('reloads the loaded range on ref changes and keeps the selection', async () => {
    await actions.loadMoreLog();
    actions.selectRow(sha(N - 700), {});
    const before = host.count('log/page');
    host.emit({ type: 'repo/changed', repo: 'r', kinds: ['refs'] });
    await vi.waitFor(() => expect(host.count('log/page')).toBe(before + 1));
    const last = host.calls.filter((c) => c.method === 'log/page').at(-1)!.params as { limit: number; offset: number };
    expect(last).toMatchObject({ offset: 0, limit: 1000 });
    await vi.waitFor(() => expect(useStore.getState().logLoading).toBe(false));
    expect(useStore.getState().selected).toEqual([sha(N - 700)]);
  });

  it('switches to file status on conflicts', async () => {
    host = new MockHost({ 'op/run': () => Promise.reject({ category: 'conflict', message: 'CONFLICT' }), 'repo/snapshot': () => snapshot, 'status/get': () => status });
    actions.setRpc(new RpcClient(host));
    actions.setView('history');
    const ok = await actions.runOp({ kind: 'merge', ref: 'x', noFastForward: false, squash: false, commit: true });
    expect(ok).toBe(false);
    expect(useStore.getState().view).toBe('fileStatus');
  });
});

describe('pull requests', () => {
  const prCalls = () => host.calls.filter((c) => c.method === 'pr/list').map((c) => (c.params as { force?: boolean }).force ?? false);

  it('loads PRs on start and forces a reload when the GitHub sign-in changes', async () => {
    await vi.waitFor(() => expect(useStore.getState().pullRequests).toEqual(openPr));
    expect(prCalls()).toEqual([false]);
    host.emit({ type: 'pr/changed' });
    await vi.waitFor(() => expect(prCalls()).toEqual([false, true]));
  });

  it('asks again after fetches and pushes, and leaves the cache to the host', async () => {
    await vi.waitFor(() => expect(prCalls()).toHaveLength(1));
    host.emit({ type: 'repo/changed', repo: 'r', kinds: ['refs'] });
    await vi.waitFor(() => expect(prCalls()).toEqual([false, false]));
    await actions.refreshAll();
    expect(prCalls()).toEqual([false, false, true, false]);
  });

  it('keeps the PRs it has when loading fails, without an error dialog', async () => {
    await vi.waitFor(() => expect(useStore.getState().pullRequests).toEqual(openPr));
    prs = new Error('offline');
    useStore.setState({ dialog: null });
    await actions.loadPullRequests(true);
    expect(useStore.getState().pullRequests).toEqual({ status: 'error', message: 'offline', byRef: openPr.byRef });
    expect(useStore.getState().dialog).toBeNull();
  });
});

describe('commit box', () => {
  it('expands only while there is something to commit or a message being written', () => {
    const expanded = () => actions.commitBoxExpanded(useStore.getState());
    useStore.setState({ commitMsg: '', amend: false });
    expect(expanded()).toBe(false);
    useStore.setState({ commitMsg: 'f' });
    expect(expanded()).toBe(true);
    // An empty line alone counts as a half-written message, so do not collapse while typing
    useStore.setState({ commitMsg: '\n' });
    expect(expanded()).toBe(true);
    useStore.setState({ commitMsg: '', status: { ...status, staged: [{ path: 'b.txt', status: 'A' }] } });
    expect(expanded()).toBe(true);
    useStore.setState({ status });
    actions.setAmend(true);
    expect(expanded()).toBe(true);
    actions.setAmend(false);
    useStore.setState({ commitMsg: '', snapshot: { ...snapshot, sequence: { kind: 'merge' } } });
    expect(expanded()).toBe(true);
    useStore.setState({ snapshot });
    expect(expanded()).toBe(false);
  });

  it('says why the commit button is disabled', () => {
    const reason = () => actions.commitBlockedReason(useStore.getState());
    const staged = { ...status, staged: [{ path: 'b.txt', status: 'A' as const }] };
    useStore.setState({ commitMsg: '', amend: false, busy: [] });
    expect(reason()).toBe('ステージ済みのファイルがありません');
    useStore.setState({ status: staged });
    expect(reason()).toBe('コミットメッセージを入力してください');
    useStore.setState({ commitMsg: 'Fix' });
    expect(reason()).toBeNull();
    useStore.setState({ status: { ...staged, conflicted: [{ path: 'c.txt', status: 'U' as const }] } });
    expect(reason()).toBe('競合を解決してからコミットします');
    // amend can be pressed even without staged files
    useStore.setState({ status, amend: true });
    expect(reason()).toBeNull();
  });

  it('labels the commit button with what it will do', () => {
    const label = () => actions.commitButtonLabel(useStore.getState());
    const withRemote = { ...snapshot, remotes: [{ name: 'origin' }] };
    useStore.setState({ amend: false, pushAfter: false, status });
    expect(label()).toBe('コミット');
    useStore.setState({ status: { ...status, staged: [{ path: 'a.txt', status: 'M' }, { path: 'b.txt', status: 'A' }] } });
    expect(label()).toBe('コミット（2 件）');
    // Without a remote there is no push, so it is not in the wording either
    useStore.setState({ pushAfter: true });
    expect(label()).toBe('コミット（2 件）');
    useStore.setState({ snapshot: withRemote });
    expect(label()).toBe('コミットしてプッシュ（2 件）');
    useStore.setState({ amend: true, status });
    expect(label()).toBe('修正してプッシュ');
    useStore.setState({ pushAfter: false, snapshot });
    expect(label()).toBe('直前のコミットを修正');
  });
});

describe('opening view', () => {
  it('opens the changes tab when the working tree has changes, otherwise the history', async () => {
    expect(useStore.getState().view).toBe('fileStatus');
    expect(useStore.getState().booted).toBe(true);
    status = { staged: [], unstaged: [], conflicted: [] };
    await actions.bootstrap({ repo: 'r', root: '/r', lang: 'ja' });
    expect(useStore.getState().view).toBe('history');
  });
});

describe('history search box', () => {
  it('reads the search kind from a prefix', () => {
    expect(parseSearch('  ')).toEqual({ kind: 'clear' });
    expect(parseSearch('ログイン画面')).toEqual({ kind: 'search', search: { mode: 'message', text: 'ログイン画面' } });
    expect(parseSearch('author: suzuki')).toEqual({ kind: 'search', search: { mode: 'author', text: 'suzuki' } });
    // An IME-typed full-width colon is also accepted
    expect(parseSearch('content：validate(')).toEqual({ kind: 'search', search: { mode: 'content', text: 'validate(' } });
    expect(parseSearch('path:src\\auth\\a.ts')).toEqual({ kind: 'path', path: 'src/auth/a.ts' });
    expect(parseSearch('author:')).toEqual({ kind: 'clear' });
  });

  it('jumps for a SHA of 7 or more hex digits or an explicit sha: prefix', () => {
    expect(parseSearch('a1c93e0')).toEqual({ kind: 'jump', rev: 'a1c93e0' });
    expect(parseSearch('sha:feature/login')).toEqual({ kind: 'jump', rev: 'feature/login' });
    // A short hex word (face, added, etc.) is searched as a message
    expect(parseSearch('face')).toEqual({ kind: 'search', search: { mode: 'message', text: 'face' } });
    expect(parseSearch('fix: typo')).toEqual({ kind: 'search', search: { mode: 'message', text: 'fix: typo' } });
  });

  it('writes the current search back to the box', () => {
    expect(formatSearch(undefined)).toBe('');
    expect(formatSearch({ mode: 'message', text: 'x' })).toBe('x');
    expect(formatSearch({ mode: 'author', text: 'suzuki' })).toBe('author:suzuki');
    for (const text of ['author:suzuki', 'content:validate(', 'ログイン']) {
      const input = parseSearch(text);
      expect(input.kind === 'search' && formatSearch(input.search)).toBe(text);
    }
  });
});
