import { statSync } from 'node:fs';
import type { LogPage, LogQuery, LogRow, Sha } from '../../shared/protocol';
import { LogCursor, type RowFilter } from '../git/LogCursor';
import { LOG_FORMAT, parseLog } from '../git/parsers/log';
import type { RepoModel } from '../repo/RepoModel';

const IDLE_MS = 60_000;
const MAX_CURSORS = 4;

/** History. A cursor is closed after 60 seconds unused, and later requests recreate it with --skip. */
export class LogService {
  private readonly cursors = new Map<string, LogCursor>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly repo: RepoModel) {
    this.sweeper = setInterval(() => this.sweep(), 15_000);
    this.sweeper.unref?.();
  }

  async page(query: LogQuery, cursorId: string | undefined, offset: number, limit: number, signal?: AbortSignal): Promise<LogPage> {
    const key = JSON.stringify(query);
    let cursor = cursorId ? this.cursors.get(cursorId) : undefined;
    if (cursor && (cursor.queryKey !== key || cursor.consumed !== offset)) {
      cursor.dispose();
      this.cursors.delete(cursor.id);
      cursor = undefined;
    }
    if (!cursor) {
      const built = await this.buildArgs(query, offset);
      if (!built) return { cursor: null, rows: [], done: true };
      cursor = new LogCursor(this.repo.runner, built.args, key, built.filter, offset);
      await cursor.start();
      this.cursors.set(cursor.id, cursor);
      this.trim();
    }
    const { rows, done } = await cursor.next(limit, signal);
    if (done) {
      cursor.dispose();
      this.cursors.delete(cursor.id);
    }
    return { cursor: done ? null : cursor.id, rows, done };
  }

  /** Build the arguments of git log. undefined if there is nothing to show */
  private async buildArgs(query: LogQuery, skip: number): Promise<{ args: string[]; filter?: RowFilter } | undefined> {
    const snap = await this.repo.snapshot.get();
    const args = ['log', query.order === 'topo' ? '--topo-order' : '--date-order', '-z', '--encoding=UTF-8', `--format=${LOG_FORMAT}`];
    if (skip > 0) args.push(`--skip=${skip}`);

    const revs: string[] = [];
    let filter: RowFilter | undefined;
    const search = query.search && query.search.text.trim() ? query.search : undefined;

    if (search?.mode === 'sha') {
      if (!/^[0-9a-f]{4,64}$/i.test(search.text.trim())) return undefined;
      args.push('--no-walk');
      revs.push(search.text.trim());
    } else {
      if (search?.mode === 'message') args.push(`--grep=${search.text}`, '--regexp-ignore-case', '--fixed-strings');
      else if (search?.mode === 'author') args.push(`--author=${search.text}`, '--regexp-ignore-case', '--fixed-strings');
      else if (search?.mode === 'content') args.push(`-G${search.text}`);

      if (query.branches === 'all') {
        args.push('--branches', '--tags');
        if (query.includeRemotes) args.push('--remotes');
        if (!snap.head.unborn) revs.push('HEAD');
        if (query.includeStashes && snap.stashes.length > 0) {
          // Do not show the stash's index or untracked commits as rows; the stash itself has only its first parent as parent
          const hidden = new Set<Sha>();
          const stashBase = new Map<Sha, Sha>();
          const detail = await this.repo.runner.run(['rev-list', '--no-walk', '--parents', ...snap.stashes.map((s) => s.sha)], {
            noThrow: true,
          });
          for (const line of detail.stdout.toString('utf8').split('\n')) {
            const [sha, first, ...rest] = line.trim().split(' ');
            if (!sha) continue;
            stashBase.set(sha, first);
            for (const h of rest) hidden.add(h);
          }
          for (const s of snap.stashes) revs.push(s.sha);
          filter = (row: LogRow) => {
            if (hidden.has(row.sha)) return undefined;
            const base = stashBase.get(row.sha);
            return base ? { ...row, parents: [base] } : row;
          };
        }
        if (snap.refs.length === 0 && snap.head.unborn) return undefined;
      } else if (query.branches === 'current') {
        if (snap.head.unborn) return undefined;
        revs.push('HEAD');
      } else {
        const valid = query.branches.refs.filter((r) => !r.startsWith('-'));
        if (valid.length === 0) return undefined;
        revs.push(...valid);
      }
    }

    if (query.path) {
      const rel = this.repo.relPath(query.path);
      let isFile = false;
      try {
        isFile = statSync(this.repo.resolvePath(query.path)).isFile();
      } catch {
        isFile = true; // History of a deleted file
      }
      // Rewrite parents with --parents so the graph stays connected even in a filtered history.
      // With --follow (follow renames) git does not rewrite parents, so the webview draws only dots
      args.push('--parents');
      if (query.follow && isFile && search?.mode !== 'sha') args.push('--follow');
      args.push('--end-of-options', ...revs, '--', rel);
    } else {
      args.push('--end-of-options', ...revs, '--');
    }
    return { args, filter };
  }

  /** A small list for interactive rebase and the like (not streamed) */
  async list(args: string[]): Promise<LogRow[]> {
    const res = await this.repo.runner.run(['log', '-z', '--encoding=UTF-8', `--format=${LOG_FORMAT}`, ...args]);
    return parseLog(res.stdout);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, c] of this.cursors) {
      if (now - c.lastUsed > IDLE_MS) {
        c.dispose();
        this.cursors.delete(id);
      }
    }
  }

  private trim(): void {
    if (this.cursors.size <= MAX_CURSORS) return;
    const oldest = [...this.cursors.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const c of oldest.slice(0, this.cursors.size - MAX_CURSORS)) {
      c.dispose();
      this.cursors.delete(c.id);
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    for (const c of this.cursors.values()) c.dispose();
    this.cursors.clear();
  }
}
