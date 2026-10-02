import { spawn, type ChildProcess } from 'node:child_process';
import { GitError, classifyGitError, extractOverwrittenFiles, summarizeStderr } from './errors';

// GitRunner. This is the only class that starts git.

export type QueueKind = 'read' | 'write' | 'net';

export interface RunOptions {
  queue?: QueueKind;
  stdin?: string | Buffer;
  signal?: AbortSignal;
  /** Extra environment variables (connection info for askpass / the editor helper, etc.) */
  env?: Record<string, string>;
  /** Exit codes that are not treated as failure (e.g. 1 for diff --no-index) */
  okExitCodes?: number[];
  /** Receives progress lines from stderr (separated by \r) */
  onProgress?: (p: { message: string; percent?: number }) => void;
  /** Wait for both net and write turns, like pull does */
  alsoWrite?: boolean;
  /** Limit for stdout (output is cut off beyond it and truncated is set) */
  maxStdoutBytes?: number;
  /** Do not throw on failure */
  noThrow?: boolean;
}

export interface GitResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  command: string;
  truncated: boolean;
}

export interface CommandLogEntry {
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stderr?: string;
}

export interface GitRunnerDeps {
  gitPath: string;
  cwd: string;
  log?: (entry: CommandLogEntry) => void;
}

const COMMON_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];

/** Drop variables from the user's environment that would change how git behaves */
const SCRUBBED_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_NAMESPACE'];

export function baseEnv(queue: QueueKind, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SCRUBBED_ENV) delete env[k];
  Object.assign(env, {
    // Keep error messages stable to parse. They are translated on the Twigline side
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    LANGUAGE: 'en_US:en',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    // Do not open an editor for non-interactive operations (git treats ":" as "do nothing")
    GIT_EDITOR: ':',
    GIT_MERGE_AUTOEDIT: 'no',
    // Always treat paths literally (do not interpret file names containing [ or * as globs)
    GIT_LITERAL_PATHSPECS: '1',
  });
  if (queue === 'read') env.GIT_OPTIONAL_LOCKS = '0';
  if (extra) Object.assign(env, extra);
  return env;
}

/** Command string for logging. Credentials in URLs are masked */
export function formatCommand(args: readonly string[]): string {
  const shown = stripCommonArgs(args).map((a) => {
    const masked = maskCredentials(a);
    return /^[\w@%+=:,./^~{}*-]+$/.test(masked) ? masked : `"${masked.replace(/(["\\$`])/g, '\\$1')}"`;
  });
  return ['git', ...shown].join(' ');
}

export function maskCredentials(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(:[^/@\s]*)?@/gi, (_m, scheme: string) => `${scheme}***@`);
}

function stripCommonArgs(args: readonly string[]): string[] {
  const out = [...args];
  while (out[0] === '-c' && COMMON_ARGS.includes(out[1] ?? '')) out.splice(0, 2);
  return out;
}

class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }

  get busy(): boolean {
    return this.active > 0;
  }
}

export class GitRunner {
  private readonly readSem = new Semaphore(4);
  private readonly writeSem = new Semaphore(1);
  private readonly netSem = new Semaphore(1);
  private writeActive = 0;
  private writeIdleWaiters: (() => void)[] = [];
  private readonly children = new Set<ChildProcess>();

  constructor(private readonly deps: GitRunnerDeps) {}

  get cwd(): string {
    return this.deps.cwd;
  }

  get gitPath(): string {
    return this.deps.gitPath;
  }

  /** Whether git is running in this repository (used to decide whether to remove a lock file) */
  get isBusy(): boolean {
    return this.children.size > 0;
  }

  /** Run git and wait for it to finish. Failure throws GitError (with noThrow, the result is returned). */
  async run(args: readonly string[], opts: RunOptions = {}): Promise<GitResult> {
    const queue = opts.queue ?? 'read';
    const releases: (() => void)[] = [];
    try {
      if (queue === 'read') {
        // A read that arrives while a write is running waits for it to finish (so it does not see an intermediate state)
        await this.waitWriteIdle(opts.signal);
        releases.push(await this.readSem.acquire());
      } else if (queue === 'write') {
        releases.push(await this.acquireWrite());
      } else {
        releases.push(await this.netSem.acquire());
        if (opts.alsoWrite) releases.push(await this.acquireWrite());
      }
      throwIfAborted(opts.signal);
      return await this.exec(args, queue, opts);
    } finally {
      for (const r of releases.reverse()) r();
    }
  }

  /** Start a process whose stdout is read little by little (for LogCursor). Does not use a queue slot. */
  async spawnStream(args: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<ChildProcess> {
    await this.waitWriteIdle(opts.signal);
    const fullArgs = [...COMMON_ARGS, ...args];
    const started = Date.now();
    const child = spawn(this.deps.gitPath, fullArgs, {
      cwd: this.deps.cwd,
      env: baseEnv('read'),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.add(child);
    let stderr = '';
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    child.on('error', () => this.children.delete(child));
    child.on('close', (code) => {
      this.children.delete(child);
      this.deps.log?.({
        command: formatCommand(args),
        cwd: this.deps.cwd,
        durationMs: Date.now() - started,
        exitCode: code,
        stderr: code ? stderr : undefined,
      });
    });
    opts.signal?.addEventListener('abort', () => killTree(child), { once: true });
    return child;
  }

  /** Terminate every running git (when the panel is closed) */
  dispose(): void {
    for (const c of this.children) killTree(c);
    this.children.clear();
  }

  private async acquireWrite(): Promise<() => void> {
    // Count from the moment a call joins the queue, so a read that arrives at the same time never runs before a write that arrived earlier
    this.writeActive++;
    const release = await this.writeSem.acquire();
    return () => {
      this.writeActive--;
      release();
      if (this.writeActive === 0) {
        const waiters = this.writeIdleWaiters;
        this.writeIdleWaiters = [];
        for (const w of waiters) w();
      }
    };
  }

  private waitWriteIdle(signal?: AbortSignal): Promise<void> {
    if (this.writeActive === 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.writeIdleWaiters.push(resolve);
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }

  private exec(args: readonly string[], queue: QueueKind, opts: RunOptions): Promise<GitResult> {
    const fullArgs = [...COMMON_ARGS, ...args];
    const command = formatCommand(args);
    const started = Date.now();
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn(this.deps.gitPath, fullArgs, {
        cwd: this.deps.cwd,
        env: baseEnv(queue, opts.env),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.children.add(child);
      const out: Buffer[] = [];
      let outBytes = 0;
      let truncated = false;
      let stderr = '';
      let progressBuf = '';
      const max = opts.maxStdoutBytes ?? 256 * 1024 * 1024;

      child.stdout!.on('data', (d: Buffer) => {
        if (truncated) return;
        if (outBytes + d.length > max) {
          out.push(d.subarray(0, max - outBytes));
          outBytes = max;
          truncated = true;
          killTree(child);
          return;
        }
        out.push(d);
        outBytes += d.length;
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (d: string) => {
        if (stderr.length < 1024 * 1024) stderr += d;
        if (opts.onProgress) {
          progressBuf += d;
          const parts = progressBuf.split(/[\r\n]/);
          progressBuf = parts.pop() ?? '';
          for (const line of parts) {
            const p = parseProgress(line);
            if (p) opts.onProgress(p);
          }
        }
      });

      const onAbort = () => killTree(child);
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        this.children.delete(child);
        opts.signal?.removeEventListener('abort', onAbort);
        reject(new GitError('unknown', `Failed to start git: ${err.message}`, { command }));
      });
      child.on('close', (code) => {
        this.children.delete(child);
        opts.signal?.removeEventListener('abort', onAbort);
        const exitCode = code ?? -1;
        this.deps.log?.({
          command,
          cwd: this.deps.cwd,
          durationMs: Date.now() - started,
          exitCode: code,
          stderr: exitCode !== 0 ? maskCredentials(stderr) : undefined,
        });
        const result: GitResult = { stdout: Buffer.concat(out), stderr, exitCode, command, truncated };
        if (opts.signal?.aborted) {
          reject(abortError());
          return;
        }
        if (exitCode === 0 || truncated || opts.okExitCodes?.includes(exitCode) || opts.noThrow) {
          resolve(result);
          return;
        }
        reject(toGitError(result, args));
      });

      if (opts.stdin !== undefined) {
        child.stdin!.on('error', () => {
          /* Ignore EPIPE when git exits without reading stdin */
        });
        child.stdin!.end(opts.stdin);
      } else {
        child.stdin!.end();
      }
    });
  }
}

export function toGitError(result: GitResult, args: readonly string[]): GitError {
  // merge and others print CONFLICT to stdout, so the beginning of stdout is also used for classification
  const stdoutHead = result.stdout.subarray(0, 64 * 1024).toString('utf8');
  const category = classifyGitError(`${result.stderr}\n${stdoutHead}`, result.exitCode, args);
  const summary =
    summarizeStderr(result.stderr) || summarizeStderr(stdoutHead) || `git exited with code ${result.exitCode}`;
  return new GitError(category, maskCredentials(summary), {
    command: result.command,
    stderr: maskCredentials(result.stderr),
    exitCode: result.exitCode,
    files: category === 'dirtyWorktree' ? extractOverwrittenFiles(result.stderr) : undefined,
  });
}

export function parseProgress(line: string): { message: string; percent?: number } | undefined {
  const text = line.replace(/^remote:\s*/, '').trim();
  if (!text) return undefined;
  const m = /^([A-Za-z ]+):\s+(\d{1,3})%/.exec(text);
  if (m) return { message: text, percent: Number(m[2]) };
  return { message: text };
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // git starts child processes such as git-remote-https, so terminate the whole tree
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {
      child.kill();
    });
  } else {
    child.kill('SIGTERM');
  }
}

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Extract [major, minor, patch] from the output of git --version */
export function parseGitVersion(output: string): { text: string; parts: [number, number, number] } {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!m) return { text: output.trim(), parts: [0, 0, 0] };
  return { text: output.replace(/^git version\s*/, '').trim(), parts: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] };
}

export function versionAtLeast(parts: [number, number, number], major: number, minor: number): boolean {
  return parts[0] > major || (parts[0] === major && parts[1] >= minor);
}
