import * as path from 'node:path';
import type { RepoId } from '../../shared/protocol';

/** Turn the normalized path of a repository root into an ID (case-insensitive on Windows) */
export function toRepoId(root: string): RepoId {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Whether `target` is `base` or inside it (compared as RepoIds: case-insensitive on Windows) */
export function isSameOrInside(target: string, base: string): boolean {
  const t = toRepoId(target);
  const b = toRepoId(base);
  if (t === b) return true;
  return t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
