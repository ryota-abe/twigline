import * as vscode from 'vscode';
import type { TwiglineConfig } from '../../shared/protocol';

export const DEFAULT_GRAPH_COLORS = ['#2f6bd8', '#c0397f', '#c98410', '#2c9a58', '#7a4fd0', '#d0503a', '#1a93a8', '#8a8f1f'];

export interface CustomAction {
  name: string;
  command: string;
  args?: string[];
  /** Run in the terminal (by default, recorded in the Twigline output) */
  terminal?: boolean;
}

/** Read the settings */
export function readConfig(): TwiglineConfig {
  // Some settings have resource scope, but the caller has no repository context, so pass null (no resource)
  // (if omitted, VS Code logs a warning on every access)
  const c = vscode.workspace.getConfiguration('twigline', null);
  const num = (key: string, def: number, min: number, max: number) => {
    const v = c.get<number>(key, def);
    return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : def;
  };
  const colors = c.get<string[]>('graph.colors', DEFAULT_GRAPH_COLORS);
  return {
    historyOrder: c.get<'date' | 'topo'>('history.order', 'date') === 'topo' ? 'topo' : 'date',
    historyBranches: c.get<'all' | 'current'>('history.branches', 'all') === 'current' ? 'current' : 'all',
    showRemoteBranches: c.get<boolean>('history.showRemoteBranches', true),
    showStashes: c.get<boolean>('history.showStashes', false),
    pageSize: num('history.pageSize', 500, 50, 10_000),
    dateFormat: c.get<string>('history.dateFormat', 'absolute'),
    graphColors: Array.isArray(colors) && colors.length > 0 ? colors.map(String) : DEFAULT_GRAPH_COLORS,
    fileStatusLayout: c.get<'split' | 'single'>('fileStatus.layout', 'split') === 'single' ? 'single' : 'split',
    fileStatusView: c.get<'list' | 'tree'>('fileStatus.view', 'list') === 'tree' ? 'tree' : 'list',
    contextLines: num('diff.contextLines', 3, 0, 25),
    ignoreWhitespace: c.get<boolean>('diff.ignoreWhitespace', false),
    maxDiffLines: num('diff.maxLines', 5000, 100, 1_000_000),
    syntaxHighlight: c.get<boolean>('diff.syntaxHighlight', true),
    forcePushMode: c.get<'withLease' | 'force'>('push.forceMode', 'withLease') === 'force' ? 'force' : 'withLease',
    rememberPushAfter: c.get<boolean>('commit.rememberPushAfter', true),
    pullRequests: c.get<boolean>('pullRequests.enabled', true),
    customActions: readCustomActions().map((a) => ({ name: a.name })),
  };
}

export function readCustomActions(): CustomAction[] {
  // application scope, so it cannot be injected from workspace settings
  const inspected = vscode.workspace.getConfiguration('twigline').inspect<CustomAction[]>('customActions');
  const list = inspected?.globalValue ?? inspected?.defaultValue ?? [];
  return Array.isArray(list) ? list.filter((a) => a && typeof a.name === 'string' && typeof a.command === 'string') : [];
}

export function gitPathSetting(): string | undefined {
  // machine scope. Values from workspace settings are not used
  const inspected = vscode.workspace.getConfiguration('twigline').inspect<string>('gitPath');
  const v = inspected?.globalValue;
  return v && v.trim() ? v.trim() : undefined;
}
