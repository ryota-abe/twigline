import { create } from 'zustand';
import type {
  ChangedFile,
  CommitDetail,
  CommitInfo,
  FileDiff,
  TwiglineConfig,
  InitData,
  LogQuery,
  LogRow,
  PullRequestList,
  RepoSnapshot,
  ViewKind,
  WorkingTreeStatus,
} from '../../../shared/protocol';
import { createLaneState, type GraphRow, type LaneState } from '../graph/layout';

// Zustand slices: repo, log, status, selection, ui, dialogs

export interface Boot {
  repo: string;
  root: string;
  dev?: boolean;
  lang?: 'ja' | 'en';
  /** URL of the syntax highlighting Worker */
  syntaxWorker?: string;
}

export type DialogKind =
  | 'pull'
  | 'push'
  | 'pushBranches'
  | 'fetch'
  | 'branch'
  | 'merge'
  | 'rebase'
  | 'tag'
  | 'stash'
  | 'discard'
  | 'reset'
  | 'checkout'
  | 'renameBranch'
  | 'setUpstream'
  | 'confirm'
  | 'stashApply'
  | 'stashBranch'
  | 'tagDelete'
  | 'tagPush'
  | 'ignore'
  | 'interactiveRebase'
  | 'settings'
  | 'editMessage'
  | 'error';

export interface DialogState {
  kind: DialogKind;
  props: Record<string, unknown>;
}

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'warning' | 'error';
  message: string;
  actions?: ToastAction[];
}

export interface BusyOp {
  id: string;
  title: string;
  message?: string;
  percent?: number;
}

export interface UiLayout {
  sidebarWidth: number;
  detailHeight: number;
  detailMetaWidth: number;
  fsListWidth: number;
  commitHeight: number;
  cols: { graph: number | null; date: number; author: number; sha: number };
  collapsed: Record<string, boolean>;
  fileView: 'list' | 'tree';
  fsLayout: 'split' | 'single';
}

export type FsGroup = 'staged' | 'unstaged' | 'conflicted';

export interface TwiglineState {
  boot: Boot;
  init: InitData | null;
  config: TwiglineConfig | null;
  snapshot: RepoSnapshot | null;
  status: WorkingTreeStatus | null;
  /** Pull requests linked to branches (null if not read yet) */
  pullRequests: PullRequestList | null;
  /** The first snapshot and status are in and the screen to open has been decided */
  booted: boolean;
  view: ViewKind;

  // History
  query: LogQuery;
  rows: LogRow[];
  cursor: string | null;
  logDone: boolean;
  logLoading: boolean;
  logError: string | null;
  graphRows: GraphRow[];
  laneState: LaneState;
  showUncommitted: boolean;
  dotsOnly: boolean;
  maxLanes: number;

  // History selection and details
  selected: string[];
  anchor: string | null;
  focusSha: string | null;
  detail: CommitDetail | null;
  detailLoading: boolean;
  detailFile: ChangedFile | null;
  detailDiff: FileDiff | null;
  /** When uncommitted changes are selected in the detail pane */
  wcFile: { group: FsGroup; path: string } | null;

  // File status
  fsSelected: { group: FsGroup; paths: string[] } | null;
  fsDiff: FileDiff | null;
  diffLoading: boolean;
  lineSel: number[];
  lineAnchor: number | null;
  diffOpts: { context: number; ignoreWhitespace: boolean };

  // Commit box
  commitMsg: string;
  amend: boolean;
  signoff: boolean;
  noVerify: boolean;
  pushAfter: boolean;
  commitInfo: CommitInfo | null;
  savedMsgBeforeAmend: string | null;

  // UI
  ui: UiLayout;
  busy: BusyOp[];
  dialog: DialogState | null;
  toasts: Toast[];
}

export const DEFAULT_UI: UiLayout = {
  sidebarWidth: 220,
  detailHeight: 300,
  detailMetaWidth: 380,
  fsListWidth: 320,
  commitHeight: 150,
  cols: { graph: null, date: 148, author: 120, sha: 80 },
  collapsed: {},
  fileView: 'list',
  fsLayout: 'split',
};

export const DEFAULT_QUERY: LogQuery = {
  branches: 'all',
  includeRemotes: true,
  includeStashes: false,
  order: 'date',
};

export const useStore = create<TwiglineState>(() => ({
  boot: { repo: '', root: '' },
  init: null,
  config: null,
  snapshot: null,
  status: null,
  pullRequests: null,
  booted: false,
  view: 'history',
  query: DEFAULT_QUERY,
  rows: [],
  cursor: null,
  logDone: false,
  logLoading: false,
  logError: null,
  graphRows: [],
  laneState: createLaneState(),
  showUncommitted: false,
  dotsOnly: false,
  maxLanes: 1,
  selected: [],
  anchor: null,
  focusSha: null,
  detail: null,
  detailLoading: false,
  detailFile: null,
  detailDiff: null,
  wcFile: null,
  fsSelected: null,
  fsDiff: null,
  diffLoading: false,
  lineSel: [],
  lineAnchor: null,
  diffOpts: { context: 3, ignoreWhitespace: false },
  commitMsg: '',
  amend: false,
  signoff: false,
  noVerify: false,
  pushAfter: false,
  commitInfo: null,
  savedMsgBeforeAmend: null,
  ui: DEFAULT_UI,
  busy: [],
  dialog: null,
  toasts: [],
}));

export const get = useStore.getState;
export const set = useStore.setState;

/** Rows being shown (including the virtual "Uncommitted Changes" row at the top) */
export function displayRowCount(s: TwiglineState): number {
  return s.rows.length + (s.showUncommitted ? 1 : 0);
}
