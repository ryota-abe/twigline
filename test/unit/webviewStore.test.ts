import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwiglineConfig, LogRow, PullRequestList, RefInfo, RepoSnapshot, WorkingTreeStatus } from '../../shared/protocol';
import { MockHost } from '../../webview/src/rpc/MockHost';
import { RpcClient } from '../../webview/src/rpc/RpcClient';
import * as actions from '../../webview/src/store/actions';
import { DEFAULT_QUERY, DEFAULT_UI, useStore } from '../../webview/src/store/store';
import { createLaneState } from '../../webview/src/graph/layout';
import { UNCOMMITTED } from '../../webview/src/util/format';
import { effectiveCommitMessage, escapeGitignore } from '../../webview/src/util/commitMessage';
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
  features: { stashStaged: true, updateRefs: true, pullAutostash: true },
  gitVersion: '2.47.1',
  objectFormat: 'sha1',
};

let status: WorkingTreeStatus;
let host: MockHost;
let prs: PullRequestList | Error;
let lastMessage: string;
let template: string | undefined;

const openPr: PullRequestList = {
  status: 'ok',
  byRef: {
    'refs/heads/main': { number: 12, title: 't', url: 'https://github.com/me/repo/pull/12', state: 'open', headRef: 'main', baseRef: 'dev', updatedAt: 0 },
  },
};

beforeEach(async () => {
  status = { staged: [], unstaged: [{ path: 'a.txt', status: 'M' }], conflicted: [] };
  prs = openPr;
  lastMessage = 'first';
  template = undefined;
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
      links: [],
    }),
    'ui/action': () => undefined,
    'commit/info': () => ({ author: {}, lastMessage, recentMessages: [lastMessage], template, pushAfter: false }),
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

describe('links in commit messages', () => {
  it('re-reads the commit details when the link settings of the repository change, keeping the parent compared', async () => {
    actions.selectRow(sha(N - 2), {});
    await vi.waitFor(() => expect(useStore.getState().detail?.sha).toBe(sha(N - 2)));
    const details = () => host.calls.filter((c) => c.method === 'commit/detail').map((c) => c.params as { sha: string; parent?: number });
    const before = details().length;
    host.emit({ type: 'links/changed' });
    await vi.waitFor(() => expect(details()).toHaveLength(before + 1));
    expect(details().at(-1)).toMatchObject({ sha: sha(N - 2), parent: 0 });
  });

  it('does not read details when no commit is shown', async () => {
    useStore.setState({ detail: null });
    const before = host.count('commit/detail');
    host.emit({ type: 'links/changed' });
    await new Promise((r) => setTimeout(r, 20));
    expect(host.count('commit/detail')).toBe(before);
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
    void actions.setAmend(true);
    expect(expanded()).toBe(true);
    void actions.setAmend(false);
    useStore.setState({ commitMsg: '', snapshot: { ...snapshot, sequence: { kind: 'merge' } } });
    expect(expanded()).toBe(true);
    useStore.setState({ snapshot });
    expect(expanded()).toBe(false);
  });

  it('fills amend with the message HEAD has now, not the one read when the tab opened', async () => {
    useStore.setState({ commitMsg: '', amend: false, savedMsgBeforeAmend: null });
    await actions.loadCommitInfo();
    expect(useStore.getState().commitInfo?.lastMessage).toBe('first');
    // Committed from a terminal: only refs/heads/main moves, so no 'head' change reaches the webview
    lastMessage = 'second';
    await actions.setAmend(true);
    expect(useStore.getState().commitMsg).toBe('second');
    await actions.setAmend(false);
    expect(useStore.getState().commitMsg).toBe('');
  });

  it('keeps what was typed or unchecked while the previous message is being read', async () => {
    useStore.setState({ commitMsg: '', amend: false, savedMsgBeforeAmend: null });
    const typed = actions.setAmend(true);
    useStore.setState({ commitMsg: 'typed' });
    await typed;
    expect(useStore.getState().commitMsg).toBe('typed');

    useStore.setState({ commitMsg: '', amend: false, savedMsgBeforeAmend: null });
    const unchecked = actions.setAmend(true);
    void actions.setAmend(false);
    await unchecked;
    expect(useStore.getState()).toMatchObject({ amend: false, commitMsg: '' });

    // A message already in the box is kept as it is
    useStore.setState({ commitMsg: 'draft', amend: false, savedMsgBeforeAmend: null });
    await actions.setAmend(true);
    expect(useStore.getState().commitMsg).toBe('draft');
  });

  it('does not put the template in the box while waiting for the message to amend', async () => {
    template = 'TEMPLATE';
    useStore.setState({ commitMsg: '', amend: false, savedMsgBeforeAmend: null, commitInfo: null });
    await actions.setAmend(true);
    expect(useStore.getState().commitMsg).toBe('first');
  });

  it('drops a commit info answer that a newer one overtook', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handlers = (host as unknown as { handlers: Record<string, () => unknown> }).handlers;
    const original = handlers['commit/info'];
    handlers['commit/info'] = () => gate.then(() => ({ author: {}, lastMessage: 'old', recentMessages: [], pushAfter: false }));
    const slow = actions.loadCommitInfo();
    handlers['commit/info'] = original;
    lastMessage = 'new';
    await actions.loadCommitInfo();
    release();
    await slow;
    expect(useStore.getState().commitInfo?.lastMessage).toBe('new');
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

describe('double-click checkout', () => {
  const feature: RefInfo = { kind: 'head', name: 'feature', fullName: 'refs/heads/feature', sha: sha(N - 3) };
  let head = 'main';
  let finish: (ok: boolean) => void;

  beforeEach(() => {
    head = 'main';
    host = new MockHost({
      'op/run': () =>
        new Promise((resolve, reject) => {
          finish = (ok) => (ok ? resolve({ commands: [] }) : reject({ category: 'dirtyWorktree', message: 'dirty' }));
        }),
      'repo/snapshot': () => ({ ...snapshot, head: { ...snapshot.head, branch: head } }),
      'status/get': () => status,
      'ui/action': () => undefined,
    });
    actions.setRpc(new RpcClient(host));
    useStore.setState({ checkout: null, toasts: [], dialog: null });
  });

  it('marks the branch while it is checked out, then flashes it once HEAD has moved onto it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const done = actions.checkoutBranch(feature);
      expect(useStore.getState().checkout).toEqual({ name: 'feature', phase: 'pending' });
      // A second double-click while it runs does not start another checkout
      void actions.checkoutBranch(feature);
      await vi.waitFor(() => expect(host.count('op/run')).toBe(1));
      finish(true);
      await done;
      expect(host.count('op/run')).toBe(1);
      expect(useStore.getState().toasts.at(-1)?.message).toBe('feature をチェックアウトしました');
      // The snapshot with the new HEAD has not arrived yet
      expect(useStore.getState().checkout?.phase).toBe('pending');
      head = 'feature';
      await actions.loadSnapshot();
      expect(useStore.getState().checkout).toEqual({ name: 'feature', phase: 'landed' });
      vi.advanceTimersByTime(actions.CHECKOUT_LANDED_MS);
      expect(useStore.getState().checkout).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the mark when the checkout fails', async () => {
    const done = actions.checkoutBranch(feature);
    await vi.waitFor(() => expect(host.count('op/run')).toBe(1));
    finish(false);
    await done;
    expect(useStore.getState().checkout).toBeNull();
    expect(useStore.getState().dialog?.kind).toBe('error');
  });

  it('does not run git for the checked-out branch or one checked out in another worktree', async () => {
    await actions.checkoutBranch({ ...feature, name: 'main', isHead: true });
    await actions.checkoutBranch({ ...feature, worktree: '/wt/feature' });
    expect(host.count('op/run')).toBe(0);
    expect(useStore.getState().checkout).toBeNull();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'warning', message: expect.stringContaining('/wt/feature') });
  });

  it('opens the checkout dialog for a remote branch', () => {
    actions.checkoutRemoteBranch({ kind: 'remote', name: 'origin/feature', fullName: 'refs/remotes/origin/feature', sha: sha(N - 3), remote: 'origin' });
    expect(useStore.getState().dialog).toMatchObject({ kind: 'checkout', props: { remoteRef: 'origin/feature', remote: 'origin' } });
    expect(host.count('op/run')).toBe(0);
  });
});

describe('fixes found in review', () => {
  const handlers = () => (host as unknown as { handlers: Record<string, (p: never) => unknown> }).handlers;
  const last = (method: string) => host.calls.filter((c) => c.method === method).at(-1)?.params;

  it('shows the error of a history query that failed instead of the rows of the previous one', async () => {
    expect(useStore.getState().rows.length).toBeGreaterThan(0);
    handlers()['log/page'] = () => Promise.reject({ category: 'unknown', message: 'fatal: invalid regex' });
    actions.setQuery({ search: { mode: 'content', text: 'x' } });
    await vi.waitFor(() => expect(useStore.getState().logError).toBe('fatal: invalid regex'));
    const s = useStore.getState();
    expect(s.rows).toEqual([]);
    expect(s.graphRows).toEqual([]);
    expect(s.showUncommitted).toBe(false);
    expect(s.logLoading).toBe(false);
  });

  it('keeps the push after commit choice when the commit info is read again, and saves it when it is remembered', async () => {
    await actions.loadCommitInfo();
    actions.setPushAfter(true);
    await vi.waitFor(() => expect(last('ui/action')).toMatchObject({ action: { kind: 'saveUiState', state: { pushAfter: true } } }));
    await actions.loadCommitInfo();
    expect(useStore.getState().pushAfter).toBe(true);
  });

  it('commits without the comment lines of the template, and starts the next message from the template', async () => {
    template = '\n# 件名: 50 文字以内\n# 本文\n';
    useStore.setState({ commitInfo: null, commitMsg: '', amend: false, status: { ...status, staged: [{ path: 'a.txt', status: 'M' }] } });
    await actions.loadCommitInfo();
    expect(useStore.getState().commitMsg).toBe(template);
    // Only the template: nothing to commit yet
    expect(actions.commitBlockedReason(useStore.getState())).toBe('コミットメッセージを入力してください');
    handlers()['commit/create'] = () => ({ sha: 'abc1234', pushed: false });
    useStore.setState({ commitMsg: `#12 修正${template}` });
    await actions.commit();
    expect(last('commit/create')).toMatchObject({ message: '#12 修正' });
    await vi.waitFor(() => expect(useStore.getState().commitMsg).toBe(template));
  });

  it('clears the box and reports the push when the push after a commit fails', async () => {
    handlers()['commit/create'] = () => ({ sha: 'abc1234', pushed: false, pushError: { category: 'network', message: 'Could not resolve host' } });
    useStore.setState({ commitMsg: 'message', amend: true });
    await actions.commit();
    const s = useStore.getState();
    expect(s.commitMsg).toBe('');
    expect(s.amend).toBe(false);
    expect(s.dialog).toMatchObject({ kind: 'error', props: { error: { category: 'network', message: 'Could not resolve host' } } });
  });

  it('removes only the comment lines the template has', () => {
    expect(effectiveCommitMessage('#1 fix\n# keep', undefined)).toBe('#1 fix\n# keep');
    expect(effectiveCommitMessage('#1 fix\n\n# hint  \n# mine\n', '\n# hint\n')).toBe('#1 fix\n\n# mine');
    expect(effectiveCommitMessage('\n# hint\n', '\n# hint\n')).toBe('');
    expect(effectiveCommitMessage('a\n', 'no comments')).toBe('a\n');
  });

  it('escapes what .gitignore would read as a pattern', () => {
    expect(escapeGitignore('docs/[draft] a*b?.txt')).toBe('docs/\\[draft] a\\*b\\?.txt');
    expect(escapeGitignore('a\\b  ')).toBe('a\\\\b\\ \\ ');
    expect(escapeGitignore('#memo.txt')).toBe('#memo.txt');
  });
});
