import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { LogRow } from '../../shared/protocol';
import { GitError } from './errors';
import type { GitRunner } from './GitRunner';
import { NulRecordSplitter, parseLogRecord } from './parsers/log';

// Keeps a running git log as a cursor and pages by stopping reading from stdout.
// When reading stops the pipe fills up and git blocks on write. The next page just continues reading from there.

export type RowFilter = (row: LogRow) => LogRow | undefined;

export class LogCursor {
  readonly id = randomBytes(8).toString('hex');
  lastUsed = Date.now();
  /** Number of lines returned so far (used as --skip when the cursor is recreated) */
  consumed: number;

  private child?: ChildProcess;
  private readonly splitter = new NulRecordSplitter();
  private buffered: LogRow[] = [];
  private want = 0;
  private ended = false;
  private failure?: Error;
  private notify?: () => void;
  private stderr = '';

  constructor(
    private readonly runner: GitRunner,
    private readonly args: readonly string[],
    readonly queryKey: string,
    private readonly filter?: RowFilter,
    skip = 0,
  ) {
    this.consumed = skip;
  }

  async start(): Promise<void> {
    const child = await this.runner.spawnStream(this.args);
    this.child = child;
    const stdout = child.stdout!;
    stdout.pause();
    stdout.on('data', (chunk: Buffer) => {
      this.splitter.push(chunk, (rec) => this.onRecord(rec));
      if (this.buffered.length >= this.want) stdout.pause();
      this.wake();
    });
    child.stderr!.on('data', (d: Buffer | string) => {
      if (this.stderr.length < 16 * 1024) this.stderr += d.toString();
    });
    child.on('close', (code) => {
      this.splitter.flush((rec) => this.onRecord(rec));
      this.ended = true;
      if (code !== 0 && code !== null && this.buffered.length === 0 && this.consumed === 0) {
        this.failure = new GitError('unknown', this.stderr.trim() || `git log exited with code ${code}`);
      }
      this.wake();
    });
    child.on('error', (err) => {
      this.failure = err;
      this.ended = true;
      this.wake();
    });
  }

  private onRecord(rec: Buffer): void {
    const row = parseLogRecord(rec);
    if (!row) return;
    const filtered = this.filter ? this.filter(row) : row;
    if (filtered) this.buffered.push(filtered);
  }

  private wake(): void {
    const n = this.notify;
    this.notify = undefined;
    n?.();
  }

  /** Read the next limit items. done means there are no more. */
  async next(limit: number, signal?: AbortSignal): Promise<{ rows: LogRow[]; done: boolean }> {
    this.lastUsed = Date.now();
    this.want = limit;
    while (this.buffered.length < limit && !this.ended && !this.failure) {
      if (signal?.aborted) break;
      const waiting = new Promise<void>((resolve) => (this.notify = resolve));
      this.child?.stdout?.resume();
      const onAbort = () => this.wake();
      signal?.addEventListener('abort', onAbort, { once: true });
      await waiting;
      signal?.removeEventListener('abort', onAbort);
    }
    this.child?.stdout?.pause();
    if (this.failure) throw this.failure;
    const rows = this.buffered.splice(0, limit);
    this.consumed += rows.length;
    this.lastUsed = Date.now();
    return { rows, done: this.ended && this.buffered.length === 0 };
  }

  get finished(): boolean {
    return this.ended && this.buffered.length === 0;
  }

  dispose(): void {
    const c = this.child;
    this.child = undefined;
    if (c && c.exitCode === null) {
      c.stdout?.destroy();
      c.kill();
    }
  }
}
