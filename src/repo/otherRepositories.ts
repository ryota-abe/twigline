import * as path from 'node:path';
import type { RepoId } from '../../shared/protocol';
import { toRepoId } from './repoId';

// "Other repositories": repositories outside the workspace that the user opened in Twigline with "Open Repository from Folder...".
// The list is kept in globalState, so every window (of the same local machine or remote) shows it. It also records that the user
// confirmed running git there: Workspace Trust does not cover folders outside the workspace.
// (This file does not import vscode)

export interface OtherRepository {
  root: string;
  /** Date.now() of the last time it was opened. The oldest ones are dropped when the list is full */
  lastOpened: number;
}

export const MAX_OTHER_REPOSITORIES = 20;

/** Read the stored value, dropping anything that is not an entry (the value may come from another version) */
export function sanitizeOthers(value: unknown): OtherRepository[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<RepoId>();
  const out: OtherRepository[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const { root, lastOpened } = v as { root?: unknown; lastOpened?: unknown };
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    const id = toRepoId(root);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ root, lastOpened: typeof lastOpened === 'number' && Number.isFinite(lastOpened) ? lastOpened : 0 });
  }
  return out;
}

/** Add (or move up) a repository. When the list is full, the one opened longest ago is dropped */
export function addOther(list: readonly OtherRepository[], root: string, now: number, max = MAX_OTHER_REPOSITORIES): OtherRepository[] {
  const id = toRepoId(root);
  return [{ root, lastOpened: now }, ...list.filter((o) => toRepoId(o.root) !== id)].sort((a, b) => b.lastOpened - a.lastOpened).slice(0, max);
}

export function removeOther(list: readonly OtherRepository[], root: string): OtherRepository[] {
  const id = toRepoId(root);
  return list.filter((o) => toRepoId(o.root) !== id);
}

export function hasOther(list: readonly OtherRepository[], root: string): boolean {
  const id = toRepoId(root);
  return list.some((o) => toRepoId(o.root) === id);
}

/** Whether `target` is `base` or inside it (case-insensitive on Windows, like RepoId) */
export function isSameOrInside(target: string, base: string): boolean {
  const t = toRepoId(target);
  const b = toRepoId(base);
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * Whether a change Twigline's own working tree watcher saw needs a status refresh: anything under the root except the .git directory
 * (its changes come from RepoWatcher's own watchers of the git directory). `rel` is relative to the root.
 */
export function isWorktreeChange(rel: string): boolean {
  if (!rel || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  if (parts[0] === '..') return false;
  return parts[0] !== '.git';
}
