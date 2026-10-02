import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { CommitDetail, DiffFileMode, DiffTarget, FileDiff, RpcParams, Sha } from '../../shared/protocol';
import { chooseEncoding, decode, displayName } from '../git/encoding';
import { GitError } from '../git/errors';
import { parseRawDiff, type RawFileDiff } from '../git/parsers/diff';
import { parseRawNumstat } from '../git/parsers/diffTree';
import type { RepoModel } from '../repo/RepoModel';

export interface CachedDiff {
  raw: RawFileDiff;
  target: DiffTarget;
  path: string;
  fingerprint: string;
  untracked: boolean;
}

const CACHE_SIZE = 32;
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const DIFF_COMMON = ['--no-color', '--no-ext-diff'];

/** Diffs and commit details. Keeps the raw bytes of a diff under a diffId. */
export class DiffService {
  private readonly cache = new Map<string, CachedDiff>();
  private readonly parentsCache = new Map<Sha, Sha[]>();

  constructor(private readonly repo: RepoModel) {}

  getCached(diffId: string): CachedDiff | undefined {
    return this.cache.get(diffId);
  }

  async parentsOf(sha: Sha): Promise<Sha[]> {
    const hit = this.parentsCache.get(sha);
    if (hit) return hit;
    const res = await this.repo.runner.run(['rev-list', '--parents', '-n', '1', '--end-of-options', sha]);
    const parts = res.stdout.toString('utf8').trim().split(' ');
    const parents = parts.slice(1).filter(Boolean);
    this.parentsCache.set(sha, parents);
    if (this.parentsCache.size > 2000) this.parentsCache.delete(this.parentsCache.keys().next().value!);
    return parents;
  }

  // -------------------------------------------------------------------------
  // Commit details
  // -------------------------------------------------------------------------

  async commitDetail(sha: Sha, compareTo: Sha | undefined, parent: number | undefined, signal?: AbortSignal): Promise<CommitDetail> {
    const r = this.repo.runner;
    const show = await r.run(
      ['show', '-s', '--encoding=UTF-8', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B', '--end-of-options', sha],
      { signal },
    );
    const [full, parentsStr, author, email, at, committer, committerEmail, ct, ...body] = show.stdout.toString('utf8').split('\0');
    const parents = parentsStr ? parentsStr.split(' ').filter(Boolean) : [];
    this.parentsCache.set(full, parents);
    const parentIndex = Math.min(Math.max(parent ?? 0, 0), Math.max(parents.length - 1, 0));

    let filesOut: Buffer;
    if (compareTo) {
      filesOut = (await r.run(['diff', '--raw', '--numstat', '-z', '-M', ...DIFF_COMMON, compareTo, full, '--'], { signal })).stdout;
    } else if (parents.length === 0) {
      filesOut = (await r.run(['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--root', '--no-commit-id', full], { signal })).stdout;
    } else {
      filesOut = (await r.run(['diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-commit-id', parents[parentIndex], full], { signal })).stdout;
    }
    return {
      sha: full,
      parents,
      author,
      email,
      authorTime: Number(at) || 0,
      committer,
      committerEmail,
      commitTime: Number(ct) || 0,
      message: body.join('\0').replace(/\n+$/, ''),
      files: parseRawNumstat(filesOut),
      compareTo,
      parentIndex,
    };
  }

  // -------------------------------------------------------------------------
  // Diff
  // -------------------------------------------------------------------------

  async get(p: Omit<RpcParams<'diff/file'>, 'repo'>, signal?: AbortSignal): Promise<FileDiff> {
    const rel = this.repo.relPath(p.path);
    const oldRel = p.oldPath ? this.repo.relPath(p.oldPath) : undefined;
    const context = Math.min(Math.max(Math.round(p.context), 0), 25);
    const ws = p.ignoreWhitespace ? ['-w'] : [];
    const r = this.repo.runner;
    const target = p.target;
    let conflicted = false;

    let args: string[];
    let okExitCodes: number[] | undefined;
    if (target.kind === 'worktree' && p.untracked) {
      args = ['diff', '--no-index', ...DIFF_COMMON, `-U${context}`, ...ws, '--', '/dev/null', rel];
      okExitCodes = [1];
    } else if (target.kind === 'worktree') {
      const st = await this.repo.status.getParsed();
      conflicted = st.conflicted.some((f) => f.path === rel);
      args = conflicted
        ? ['diff', ...DIFF_COMMON, '--no-renames', `-U${context}`, ...ws, 'HEAD', '--', rel]
        : ['diff', ...DIFF_COMMON, '--no-renames', `-U${context}`, ...ws, '--', rel];
    } else if (target.kind === 'index') {
      args = ['diff', '--cached', ...DIFF_COMMON, '--no-renames', `-U${context}`, ...ws, '--', rel];
    } else if (target.kind === 'commit') {
      const parents = await this.parentsOf(target.sha);
      const paths = oldRel && oldRel !== rel ? [oldRel, rel] : [rel];
      if (parents.length === 0) {
        args = ['diff-tree', '-p', '-r', '--root', '--no-commit-id', '-M', ...DIFF_COMMON, `-U${context}`, ...ws, target.sha, '--', ...paths];
      } else {
        const parent = parents[Math.min(target.parent ?? 0, parents.length - 1)];
        args = ['diff', ...DIFF_COMMON, '-M', `-U${context}`, ...ws, parent, target.sha, '--', ...paths];
      }
    } else {
      const paths = oldRel && oldRel !== rel ? [oldRel, rel] : [rel];
      args = ['diff', ...DIFF_COMMON, '-M', `-U${context}`, ...ws, target.from, target.to, '--', ...paths];
    }

    const [res, fingerprint] = await Promise.all([
      r.run(args, { signal, okExitCodes, maxStdoutBytes: MAX_DIFF_BYTES }),
      this.fingerprint(target, rel),
    ]);
    const raw = parseRawDiff(res.stdout);
    const untracked = !!p.untracked && target.kind === 'worktree';

    const diffId = randomBytes(8).toString('hex');
    this.cache.set(diffId, { raw, target, path: rel, fingerprint, untracked });
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);

    // Encoding: decided from the bytes of the lines in the diff
    const abs = this.repo.resolvePath(rel);
    const sampleParts: Buffer[] = [];
    let sampleBytes = 0;
    outer: for (const h of raw.hunks) {
      for (const l of h.lines) {
        sampleParts.push(l.content);
        sampleBytes += l.content.length;
        if (sampleBytes > 64 * 1024) break outer;
      }
    }
    const encoding = chooseEncoding(Buffer.concat(sampleParts), this.repo.env.encodingFor(abs));

    const maxLines = this.repo.env.config().maxDiffLines;
    const limit = p.full ? Number.POSITIVE_INFINITY : maxLines;
    let shown = 0;
    let truncated = res.truncated;
    const hunks: FileDiff['hunks'] = [];
    for (const h of raw.hunks) {
      if (shown >= limit) {
        truncated = true;
        break;
      }
      const lines: FileDiff['hunks'][number]['lines'] = [];
      for (const l of h.lines) {
        if (shown >= limit) {
          truncated = true;
          break;
        }
        let content = l.content;
        const crlf = content.length > 0 && content[content.length - 1] === 0x0d;
        if (crlf) content = content.subarray(0, content.length - 1);
        lines.push({
          id: l.id,
          kind: l.kind,
          oldNo: l.oldNo,
          newNo: l.newNo,
          text: decode(content, encoding),
          crlf: crlf || undefined,
          noEol: l.noEol || undefined,
        });
        shown++;
      }
      hunks.push({
        index: h.index,
        header: decode(h.headerBytes, encoding),
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines,
      });
    }

    let fileMode: DiffFileMode = 'modified';
    if (untracked) fileMode = 'untracked';
    else if (raw.submodule) fileMode = 'submodule';
    else if (raw.newFile) fileMode = 'added';
    else if (raw.deletedFile) fileMode = 'deleted';
    else if (raw.modeChange && raw.hunks.length === 0) fileMode = 'modeChange';

    const lineOps =
      (target.kind === 'worktree' || target.kind === 'index') &&
      !conflicted &&
      !raw.binary &&
      !raw.submodule &&
      !raw.deletedFile &&
      !p.ignoreWhitespace &&
      !truncated &&
      raw.hunks.length > 0;

    const diff: FileDiff = {
      diffId,
      fingerprint,
      path: rel,
      target,
      binary: raw.binary,
      truncated,
      totalLines: raw.totalLines,
      encoding: displayName(encoding),
      fileMode,
      lineOps,
      hunks,
    };
    const mime = IMAGE_TYPES[path.extname(rel).toLowerCase()];
    if (mime && (raw.binary || mime === 'image/svg+xml')) {
      diff.image = await this.loadImages(target, rel, oldRel, untracked, mime);
    }
    return diff;
  }

  /** State of the index and working tree when fetched. Compared before a line-level operation and not applied if it differs */
  async fingerprint(target: DiffTarget, rel: string): Promise<string> {
    if (target.kind !== 'worktree' && target.kind !== 'index') return '';
    const r = this.repo.runner;
    const [ls, head] = await Promise.all([
      r.run(['ls-files', '-s', '-z', '--', rel]),
      r.run(['rev-parse', '-q', '--verify', 'HEAD'], { noThrow: true }),
    ]);
    let wt = 'missing';
    try {
      const s = await stat(this.repo.resolvePath(rel));
      wt = `${s.size}:${Math.floor(s.mtimeMs)}`;
    } catch {
      /* Deleted file */
    }
    return `${ls.stdout.toString('utf8')}|${wt}|${head.stdout.toString('utf8').trim()}`;
  }

  private async loadImages(target: DiffTarget, rel: string, oldRel: string | undefined, untracked: boolean, mime: string) {
    const blob = async (spec: string): Promise<string | undefined> => {
      const res = await this.repo.runner.run(['cat-file', 'blob', spec], { noThrow: true, maxStdoutBytes: MAX_IMAGE_BYTES + 1 });
      if (res.exitCode !== 0 || res.truncated) return undefined;
      return `data:${mime};base64,${res.stdout.toString('base64')}`;
    };
    const file = async (): Promise<string | undefined> => {
      try {
        const buf = await readFile(this.repo.resolvePath(rel));
        if (buf.length > MAX_IMAGE_BYTES) return undefined;
        return `data:${mime};base64,${buf.toString('base64')}`;
      } catch {
        return undefined;
      }
    };
    const before = oldRel ?? rel;
    switch (target.kind) {
      case 'worktree':
        return { before: untracked ? undefined : await blob(`:${rel}`), after: await file() };
      case 'index':
        return { before: await blob(`HEAD:${rel}`), after: await blob(`:${rel}`) };
      case 'commit': {
        const parents = await this.parentsOf(target.sha);
        const parent = parents[Math.min(target.parent ?? 0, Math.max(parents.length - 1, 0))];
        return { before: parent ? await blob(`${parent}:${before}`) : undefined, after: await blob(`${target.sha}:${rel}`) };
      }
      case 'range':
        return { before: await blob(`${target.from}:${before}`), after: await blob(`${target.to}:${rel}`) };
    }
  }

  /** Check that the diff being shown is still valid. A stale one gives a stale error */
  async assertFresh(cached: CachedDiff): Promise<void> {
    const now = await this.fingerprint(cached.target, cached.path);
    if (now !== cached.fingerprint) {
      throw new GitError('stale', 'The diff has changed. It has been refreshed.');
    }
  }
}
