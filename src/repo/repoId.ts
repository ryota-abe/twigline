import * as path from 'node:path';
import type { RepoId } from '../../shared/protocol';

/** Turn the normalized path of a repository root into an ID (case-insensitive on Windows) */
export function toRepoId(root: string): RepoId {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
