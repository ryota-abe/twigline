// Types shared by the host (Extension Host) and the webview: the RPC protocol.
// This file has no run-time code, only types (so it does not affect either bundle).

export type RepoId = string; // Normalized path of the repository root
export type Sha = string; // 40 digits (SHA-1) or 64 digits (SHA-256)

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

export type RefKind = 'head' | 'remote' | 'tag';

export interface RefInfo {
  kind: RefKind;
  /** Short name: main, origin/main, v1.0 */
  name: string;
  /** Full name: refs/heads/main */
  fullName: string;
  /** Commit the ref points to (for an annotated tag, the commit it points at) */
  sha: Sha;
  /** Upstream of a local branch (short name) */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** The upstream branch no longer exists on the remote */
  gone?: boolean;
  isHead?: boolean;
  /** Path of another worktree the local branch is checked out in (git refuses to delete it or to check it out here) */
  worktree?: string;
  /** Remote name when kind === 'remote' */
  remote?: string;
  /** Annotated tag */
  annotated?: boolean;
}

export interface RemoteInfo {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
  /** Authentication failed in the periodic fetch */
  authRequired?: boolean;
}

export interface StashInfo {
  index: number;
  sha: Sha;
  /** Only the first parent (HEAD when the stash was made); the index and untracked commits are not included */
  base: Sha;
  message: string;
  time: number;
}

export interface HeadInfo {
  sha: Sha | null;
  branch: string | null;
  detached: boolean;
  /** Before the first commit */
  unborn: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

export type SequenceKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface SequenceState {
  kind: SequenceKind;
  /** Which step of the rebase this is (1-based) */
  step?: number;
  total?: number;
  interactive?: boolean;
  /** Name of the branch being rebased */
  branch?: string;
  /** What it is rebased onto */
  onto?: Sha;
  /** Commit being applied (MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, or the commit being applied by a rebase) */
  incoming?: Sha;
  /** Name of the branch being merged in (inferred from MERGE_MSG) */
  incomingName?: string;
  /** Stopped at an edit */
  stoppedForEdit?: boolean;
}

export interface SubmoduleInfo {
  path: string;
  sha?: Sha;
}

export interface RepoSnapshot {
  repo: RepoId;
  root: string;
  name: string;
  head: HeadInfo;
  refs: RefInfo[];
  remotes: RemoteInfo[];
  stashes: StashInfo[];
  sequence: SequenceState | null;
  submodules: SubmoduleInfo[];
  user: { name?: string; email?: string };
  /** pullAutostash: --autostash works for git merge and git pull without --rebase (git 2.27) */
  features: { stashStaged: boolean; updateRefs: boolean; pullAutostash: boolean };
  gitVersion: string;
  objectFormat: 'sha1' | 'sha256';
}

// ---------------------------------------------------------------------------
// Pull requests (PRs linked to branches: GitHub, GitHub Enterprise Server, Bitbucket Cloud)
// ---------------------------------------------------------------------------

/** Service the PRs are read from (Bitbucket means Bitbucket Cloud only) */
export type PullRequestProvider = 'github' | 'bitbucket';

/** open and draft are under review; merged and closed are finished (closed means closed without merging) */
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

export interface PullRequestInfo {
  number: number;
  title: string;
  /** PR page to open in the browser */
  url: string;
  state: PullRequestState;
  /** Detailed reason for closed (Bitbucket: declined or superseded by another PR) */
  closedAs?: 'declined' | 'superseded';
  /** Source branch of the PR (name on the remote) */
  headRef: string;
  /** Target branch */
  baseRef: string;
  /** Commit the PR's source branch points to */
  headSha?: Sha;
  author?: string;
  /** UNIX seconds */
  updatedAt: number;
}

export interface PullRequestList {
  /**
   * ok: fetched, unsupported: no GitHub / Bitbucket remote, disabled: turned off by the setting (twigline.pullRequests.enabled),
   * signIn: sign-in is required (private repository or unauthenticated rate limit), error: could not fetch (the reason is in message)
   */
  status: 'ok' | 'unsupported' | 'disabled' | 'signIn' | 'error';
  /** Which service, for signIn and error */
  provider?: PullRequestProvider;
  message?: string;
  /** Names of the remotes PRs can be read from (GitHub, Bitbucket Cloud). Tells "no PR" apart from "not a hosted remote" */
  hostedRemotes?: string[];
  /** Full ref name (refs/heads/x, refs/remotes/origin/x) -> the PR of that branch. The previous result is kept on error */
  byRef: Record<string, PullRequestInfo>;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface LogQuery {
  branches: 'all' | 'current' | { refs: string[] };
  includeRemotes: boolean;
  includeStashes: boolean;
  order: 'date' | 'topo';
  /** File history */
  path?: string;
  /**
   * Follow renames in file history (--follow). git does not rewrite parents with --follow,
   * so graph lines cannot be drawn and only dots are shown. When false, parents are rewritten and the graph is drawn.
   */
  follow?: boolean;
  search?: { mode: 'message' | 'author' | 'content' | 'sha'; text: string };
}

export interface LogRow {
  sha: Sha;
  parents: Sha[];
  author: string;
  email: string;
  /** UNIX seconds */
  authorTime: number;
  subject: string;
}

export interface LogPage {
  cursor: string | null;
  rows: LogRow[];
  /** There are no more */
  done: boolean;
}

// ---------------------------------------------------------------------------
// Commit details and diffs
// ---------------------------------------------------------------------------

export type FileStatusCode = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileStatusCode;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface CommitDetail {
  sha: Sha;
  parents: Sha[];
  author: string;
  email: string;
  authorTime: number;
  committer: string;
  committerEmail: string;
  commitTime: number;
  message: string;
  files: ChangedFile[];
  /** Base of the comparison when a range is selected */
  compareTo?: Sha;
  /** Parent being compared for a merge commit (0-based) */
  parentIndex: number;
}

export type DiffTarget =
  | { kind: 'worktree' } // index -> working tree
  | { kind: 'index' } // HEAD → index
  | { kind: 'commit'; sha: Sha; parent?: number } // n-th parent -> sha (default: the first parent, 0-based)
  | { kind: 'range'; from: Sha; to: Sha }; // when two commits are selected

export interface DiffLine {
  id: number;
  kind: ' ' | '+' | '-';
  oldNo?: number;
  newNo?: number;
  text: string;
  /** Line ends with CRLF */
  crlf?: boolean;
  /** Followed by "\ No newline at end of file" */
  noEol?: boolean;
}

export interface DiffHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileMode = 'modified' | 'added' | 'deleted' | 'untracked' | 'modeChange' | 'submodule';

export interface FileDiff {
  /** Key for keeping the raw bytes on the host */
  diffId: string;
  /** State of the index and working tree when fetched. Prevents applying to a stale diff */
  fingerprint: string;
  path: string;
  target: DiffTarget;
  binary: boolean;
  truncated: boolean;
  totalLines: number;
  encoding: string;
  fileMode: DiffFileMode;
  /** Whether line-level operations are possible (not for binary files, deletions or submodules) */
  lineOps: boolean;
  /** Before and after images of an image file (data: URI) */
  image?: { before?: string; after?: string };
  hunks: DiffHunk[];
}

// ---------------------------------------------------------------------------
// Working tree
// ---------------------------------------------------------------------------

export interface StatusFile {
  path: string;
  status: FileStatusCode;
  submodule?: boolean;
  /** Kind of conflict (UU, AA, DU, ...) */
  conflict?: string;
}

export interface WorkingTreeStatus {
  staged: StatusFile[];
  unstaged: StatusFile[];
  conflicted: StatusFile[];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type TodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface TodoItem {
  action: TodoAction;
  sha: Sha;
  subject: string;
  /** New message used by reword and squash */
  message?: string;
}

export type Operation =
  | { kind: 'checkout'; ref: string; createTracking?: string; detach?: boolean }
  | { kind: 'branch/create'; name: string; start: string; checkout: boolean }
  | { kind: 'branch/delete'; names: string[]; force: boolean; remoteBranches?: { remote: string; branch: string }[] }
  | { kind: 'branch/rename'; from: string; to: string }
  | { kind: 'branch/setUpstream'; branch: string; upstream: string | null }
  | { kind: 'remoteBranch/delete'; remote: string; branch: string }
  | { kind: 'merge'; ref: string; noFastForward: boolean; squash: boolean; commit: boolean; autostash?: boolean }
  | { kind: 'rebase'; onto: string; autostash: boolean; updateRefs: boolean }
  | { kind: 'cherry-pick'; shas: Sha[]; noCommit: boolean }
  | { kind: 'revert'; sha: Sha }
  | { kind: 'reset'; sha: Sha; mode: 'soft' | 'mixed' | 'hard' }
  | { kind: 'fetch'; remote: string | '*'; prune: boolean; tags: boolean }
  /** into: when updating a branch that is not checked out (fast-forward only; when omitted, merge into HEAD) */
  | { kind: 'pull'; remote: string; branch: string; rebase: boolean; ffOnly: boolean; into?: string; autostash?: boolean }
  | {
      kind: 'push';
      remote: string;
      branches: { local: string; remote: string; setUpstream: boolean }[];
      tags: boolean;
      force: boolean;
    }
  | { kind: 'stash/push'; message?: string; keepIndex: boolean; includeUntracked: boolean; stagedOnly: boolean }
  | { kind: 'stash/apply'; index: number; drop: boolean; restoreIndex: boolean }
  | { kind: 'stash/drop'; index: number }
  | { kind: 'stash/branch'; index: number; name: string }
  | { kind: 'tag/create'; name: string; sha: Sha; message?: string; pushTo?: string }
  | { kind: 'tag/delete'; name: string; remote?: string }
  | { kind: 'tag/push'; name: string; remote: string }
  | { kind: 'discard'; paths: string[]; untracked: string[] }
  | { kind: 'conflict/resolve'; paths: string[]; side: 'current' | 'incoming' }
  | { kind: 'conflict/mark'; paths: string[]; resolved: boolean }
  | { kind: 'file/restore'; sha: Sha; path: string }
  | { kind: 'gitignore/add'; pattern: string }
  | { kind: 'remote/add'; name: string; url: string }
  | { kind: 'remote/edit'; name: string; newName: string; url: string }
  | { kind: 'remote/remove'; name: string }
  | { kind: 'config/user'; name: string; email: string }
  | { kind: 'rebase/interactive'; base: Sha | null; todo: TodoItem[] }
  | { kind: 'sequence/control'; action: 'continue' | 'skip' | 'abort'; message?: string }; // during merge, rebase or cherry-pick

export type OperationKind = Operation['kind'];

export interface OpResult {
  /** The git commands that were run (or would be run, for dryRun) */
  commands: string[];
  /** Summary of the result to show to the user */
  message?: string;
  /** Stopped partway, e.g. because of a conflict */
  stopped?: boolean;
}

export type GitErrorCategory =
  | 'conflict'
  | 'dirtyWorktree'
  | 'rejected'
  | 'auth'
  | 'locked'
  | 'noUpstream'
  | 'network'
  | 'stale'
  | 'cancelled'
  | 'invalid'
  | 'unknown';

export interface RpcError {
  category: GitErrorCategory;
  message: string;
  command?: string;
  stderr?: string;
  /** Files concerned when dirtyWorktree */
  files?: string[];
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

export interface TwiglineConfig {
  historyOrder: 'date' | 'topo';
  historyBranches: 'all' | 'current';
  showRemoteBranches: boolean;
  showStashes: boolean;
  pageSize: number;
  dateFormat: string;
  graphColors: string[];
  fileStatusLayout: 'split' | 'single';
  fileStatusView: 'list' | 'tree';
  contextLines: number;
  ignoreWhitespace: boolean;
  maxDiffLines: number;
  syntaxHighlight: boolean;
  forcePushMode: 'withLease' | 'force';
  rememberPushAfter: boolean;
  /** Show the pull requests linked to branches (twigline.pullRequests.enabled) */
  pullRequests: boolean;
  customActions: { name: string }[];
}

export interface InitData {
  repo: RepoId;
  root: string;
  name: string;
  language: 'ja' | 'en';
  platform: 'win32' | 'darwin' | 'linux' | string;
  config: TwiglineConfig;
  /** Screen to show first when the panel opens */
  initialView?: ViewKind;
  /** Path when opened as a file history */
  initialPath?: string;
}

/** Main tabs: changes (file status) and history. Search is done inside history */
export type ViewKind = 'fileStatus' | 'history';

export interface CommitInfo {
  author: { name?: string; email?: string };
  lastMessage?: string;
  recentMessages: string[];
  template?: string;
  pushAfter: boolean;
  upstream?: string;
}

export interface RebaseCommit {
  sha: Sha;
  subject: string;
  message: string;
  author: string;
  authorTime: number;
  isMerge: boolean;
}

export type UiAction =
  | { kind: 'openDiff'; target: DiffTarget; path: string; oldPath?: string }
  | { kind: 'openFile'; path: string; sha?: Sha }
  | { kind: 'compareWithWorktree'; sha: Sha; path: string }
  | { kind: 'revealInOS'; path: string }
  | { kind: 'copy'; text: string }
  | { kind: 'showOutput' }
  | { kind: 'openMergeEditor'; path: string }
  | { kind: 'openGitignore' }
  | { kind: 'createPatch'; shas: Sha[] }
  | { kind: 'createPullRequest'; branch: string }
  /** Open the PR linked to a ref (full name) in the browser. The host looks up the URL from the previous fetch result */
  | { kind: 'openPullRequest'; ref: string }
  /** Sign in to read PRs (GitHub: the VS Code account; Bitbucket: an API token) */
  | { kind: 'pullRequestSignIn'; provider: PullRequestProvider }
  | { kind: 'customAction'; sha?: Sha; path?: string; ref?: string }
  | { kind: 'openSettings' }
  | { kind: 'openRepo'; path: string }
  | { kind: 'removeLock' }
  | { kind: 'optimize' }
  | { kind: 'saveUiState'; state: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Syntax highlighting (Shiki runs in a Web Worker; the host reads the grammars and color theme and passes them over)
// ---------------------------------------------------------------------------

/** TextMate grammar (the JSON from a VS Code extension, passed through as is) */
export interface SyntaxGrammar {
  scopeName: string;
  /** Scope to inject into (injectTo of contributes.grammars) */
  injectTo?: string[];
  grammar: Record<string, unknown>;
}

/** Language of the file and the grammars needed for coloring (main, included, injected) */
export interface SyntaxLanguage {
  id: string;
  scopeName: string;
  grammars: SyntaxGrammar[];
}

export interface SyntaxTokenColor {
  scope?: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

/** Part of the current color theme that concerns token colors */
export interface SyntaxTheme {
  /** Key that changes when the content changes (to tell whether it is already loaded in the Worker) */
  key: string;
  name: string;
  type: 'dark' | 'light';
  fg?: string;
  bg?: string;
  tokenColors: SyntaxTokenColor[];
}

/**
 * How two commits relate, for the dialogs that show what an operation would do (pull, merge, rebase...).
 * ahead / behind are seen from ours, like RefInfo: commits only ours has / only theirs has
 */
export interface RefComparison {
  ours: Sha;
  theirs: Sha;
  ahead: number;
  behind: number;
  /** null for unrelated histories */
  mergeBase: Sha | null;
  /** Paths theirs changed since the merge base (when files was asked). Cut off at a limit, then truncated is set */
  incomingFiles?: string[];
  incomingFilesTruncated?: boolean;
  /**
   * Paths a merge of theirs into ours would conflict in (when conflicts was asked and the histories have diverged).
   * Predicted with git merge-tree; null when it cannot be predicted (git older than 2.38, unrelated histories)
   */
  conflicts?: string[] | null;
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export interface RpcMethods {
  'app/init': (p: { repo: RepoId }) => InitData & { uiState: Record<string, unknown> };
  'repo/snapshot': (p: { repo: RepoId }) => RepoSnapshot;
  'repo/resolve': (p: { repo: RepoId; rev: string }) => Sha | null;
  'ref/validate': (p: { repo: RepoId; name: string }) => { valid: boolean };
  /** null when either side does not resolve to a commit */
  'ref/compare': (p: { repo: RepoId; ours: string; theirs: string; files?: boolean; conflicts?: boolean }) => RefComparison | null;
  /** ahead / behind of each ref (full names) against base; ahead counts the commits only the ref has. null when base does not resolve */
  /** Commits from..to (reachable from from, not from to) that no ref other than branch has: what a reset of branch leaves only in the reflog */
  'ref/exclusive': (p: { repo: RepoId; from: string; to: string; branch?: string }) => number | null;
  'ref/aheadBehind': (p: { repo: RepoId; base: string; refs: string[] }) => Record<string, { ahead: number; behind: number }> | null;
  'log/page': (p: { repo: RepoId; query: LogQuery; cursor?: string; offset: number; limit: number }) => LogPage;
  'commit/detail': (p: { repo: RepoId; sha: Sha; compareTo?: Sha; parent?: number }) => CommitDetail;
  'commit/info': (p: { repo: RepoId }) => CommitInfo;
  'diff/file': (p: {
    repo: RepoId;
    target: DiffTarget;
    path: string;
    /** Old path of a rename (commit diff) */
    oldPath?: string;
    context: number;
    ignoreWhitespace: boolean;
    untracked?: boolean;
    /** Return everything even beyond twigline.diff.maxLines ("Show all") */
    full?: boolean;
  }) => FileDiff;
  'status/get': (p: { repo: RepoId }) => WorkingTreeStatus;
  'stage/paths': (p: { repo: RepoId; paths: string[]; action: 'stage' | 'unstage' }) => void;
  'stage/lines': (p: { repo: RepoId; diffId: string; lineIds: number[]; action: 'stage' | 'unstage' | 'discard' }) => void;
  'commit/create': (p: {
    repo: RepoId;
    message: string;
    amend: boolean;
    signoff: boolean;
    noVerify: boolean;
    pushAfter: boolean;
  }) => { sha: Sha; pushed: boolean };
  'op/run': (p: { repo: RepoId; op: Operation; dryRun?: boolean }) => OpResult; // dryRun is for previewing the command
  'rebase/commits': (p: { repo: RepoId; base: Sha | null }) => RebaseCommit[];
  /** PR linked to a branch. The host caches it for a short time (force re-fetches) */
  'pr/list': (p: { repo: RepoId; force?: boolean }) => PullRequestList;
  'ui/action': (p: { repo: RepoId; action: UiAction }) => void;
  'ui/editMessageReply': (p: { requestId: string; message: string | null }) => void;
  /** null when the language cannot be determined or the grammar cannot be read (shown without highlighting) */
  'syntax/language': (p: {
    path: string;
    /** Languages already loaded in the webview. When one matches, grammars is returned empty */
    loaded: string[];
  }) => SyntaxLanguage | null;
  'syntax/theme': (p: Record<string, never>) => SyntaxTheme | null;
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = Parameters<RpcMethods[M]>[0];
export type RpcResult<M extends RpcMethod> = ReturnType<RpcMethods[M]>;

// ---- Host -> Webview: notifications ----
export type ChangeKind = 'status' | 'refs' | 'head' | 'stash' | 'sequence' | 'config';

/** UI actions passed to the webview from context menus and the Command Palette */
export interface UiCommand {
  command: string;
  context: Record<string, unknown>;
}

export type HostEvent =
  | { type: 'repo/changed'; repo: RepoId; kinds: ChangeKind[] }
  | { type: 'op/progress'; opId: string; title: string; message: string; percent?: number }
  | { type: 'op/finished'; opId: string; ok: boolean }
  | { type: 'config/changed'; config: TwiglineConfig }
  /** The color theme, token color settings or extensions changed. The webview re-reads the theme and languages */
  | { type: 'syntax/changed' }
  /** The GitHub / Bitbucket sign-in state changed. The webview re-fetches PRs */
  | { type: 'pr/changed' }
  | { type: 'ui/command'; command: UiCommand }
  | { type: 'ui/showView'; view: ViewKind; path?: string; focusSearch?: boolean }
  | { type: 'ui/editMessage'; requestId: string; title: string; initial: string };

// ---- Envelope ----
export type Envelope =
  | { t: 'req'; id: number; method: RpcMethod; params: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: RpcError }
  | { t: 'cancel'; id: number }
  | { t: 'evt'; event: HostEvent };
