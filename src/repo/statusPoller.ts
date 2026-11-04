import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { ParsedStatus } from '../git/parsers/status';

// Noticing working tree changes of a repository vscode.git does not know (one outside the workspace, say) without watching its folder:
// `git status` is read again on events (the host decides which) and every few seconds while the panel is in use, and the panel is
// told only when the result differs. A watcher of a folder outside the workspace uses up inotify watches on Linux and may miss
// changes on network drives; reading status works everywhere.
// (This file does not import vscode)

export interface StatusPollerOptions {
  /**
   * Read the state and return its fingerprint. undefined skips this time (a write operation is running, say).
   * `resync` reads take the state the panel was just told about: they may use cached results instead of running git again.
   */
  read: (opts: { resync: boolean }) => Promise<string | undefined>;
  /** The fingerprint differs from the last one */
  onChange: (previous: string, current: string) => void;
  /** Interval while active: the time `read` took × factor, between min and max (a slow status is read less often) */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  factor?: number;
  /** Events that come together (a save and the file events of it) are read once */
  debounceMs?: number;
}

export class StatusPoller {
  private active = false;
  private running = false;
  /** The next read only takes a new baseline (see resync) */
  private silent = false;
  /** Something came while reading: read once more right after (silently when the last thing was a resync) */
  private again = false;
  private againSilent = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** The timer is for an event (kept when the poller becomes inactive), not the next periodic read */
  private timerForEvent = false;
  private last?: string;
  private readonly min: number;
  private readonly max: number;
  private readonly factor: number;
  private readonly debounceMs: number;

  constructor(private readonly opts: StatusPollerOptions) {
    this.min = opts.minIntervalMs ?? 5_000;
    this.max = opts.maxIntervalMs ?? 60_000;
    this.factor = opts.factor ?? 20;
    this.debounceMs = opts.debounceMs ?? 150;
  }

  /** Poll while active (the panel is visible and the window has focus). Becoming active reads at once */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) this.request(false);
    else if (!this.timerForEvent) this.clear();
  }

  /** Something may have changed (a file was saved in VS Code, say): read soon, active or not */
  poke(): void {
    this.request(false);
  }

  /**
   * The panel was told about a change some other way (a Twigline operation, the .git watcher) and reads the status itself:
   * take the new state as the baseline without telling it again. A poke after it makes the read a normal one again.
   */
  resync(): void {
    this.request(true);
  }

  private request(silent: boolean): void {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      this.againSilent = silent;
      return;
    }
    // A pending read for an event stays normal when it was: it may be for a change the resync does not cover
    this.silent = silent && (this.silent || !this.timerForEvent);
    this.schedule(this.debounceMs, true);
  }

  private schedule(delay: number, forEvent: boolean): void {
    this.clear();
    this.timerForEvent = forEvent;
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerForEvent = false;
  }

  private async run(): Promise<void> {
    this.timer = undefined;
    this.timerForEvent = false;
    if (this.disposed) return;
    const silent = this.silent;
    this.silent = false;
    this.running = true;
    const start = Date.now();
    let fingerprint: string | undefined;
    try {
      fingerprint = await this.opts.read({ resync: silent });
    } catch {
      fingerprint = undefined;
    }
    const took = Date.now() - start;
    this.running = false;
    if (this.disposed) return;
    if (fingerprint !== undefined) {
      // The first read is the baseline: the panel reads the status itself when it opens
      const previous = this.last;
      this.last = fingerprint;
      if (!silent && previous !== undefined && previous !== fingerprint) this.opts.onChange(previous, fingerprint);
    }
    if (this.again) {
      this.again = false;
      this.silent = this.againSilent;
      this.schedule(this.debounceMs, true);
    } else if (this.active) {
      this.schedule(Math.min(this.max, Math.max(this.min, took * this.factor)), false);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }
}

/** Files whose time and size are read for the fingerprint (beyond this, a change to an already changed file is noticed only by its status) */
const MAX_STAT_FILES = 500;
/** stat calls at a time (a network drive answers slowly; the extension host must not wait on all of them at once) */
const STAT_CONCURRENCY = 16;

/**
 * What the panel shows, as a string. The first line is HEAD (branch, commit, upstream and ahead / behind: see headChanged);
 * the rest is the changed files and their status, and the time and size of the index and of each changed file in the working tree
 * (so editing a file that is already modified, which keeps its status, is noticed and its diff is read again).
 */
export async function statusFingerprint(root: string, gitDir: string, s: ParsedStatus): Promise<string> {
  const worktree = [...s.conflicted.map((f) => ['C', f.path, f.conflict ?? '']), ...s.unstaged.map((f) => ['U', f.path, f.status])];
  const statted = worktree.slice(0, MAX_STAT_FILES);
  const times = new Array<string>(statted.length);
  for (let i = 0; i < statted.length; i += STAT_CONCURRENCY) {
    const batch = statted.slice(i, i + STAT_CONCURRENCY);
    const results = await Promise.all(batch.map(([, rel]) => statOf(path.join(root, rel))));
    results.forEach((r, j) => (times[i + j] = r));
  }
  const files = [
    ...worktree.map((f, i) => [...f, times[i] ?? '']),
    // Staged changes are in the index, whose time and size stand for them
    ...s.staged.map((f) => ['S', f.path, f.status]),
  ];
  return `${JSON.stringify(s.branch)}\n${JSON.stringify({ index: await statOf(path.join(gitDir, 'index')), files })}`;
}

/** Whether HEAD differs between two fingerprints (a commit, checkout or reset elsewhere: the history needs reading too) */
export function headChanged(previous: string, current: string): boolean {
  return previous.slice(0, previous.indexOf('\n')) !== current.slice(0, current.indexOf('\n'));
}

async function statOf(abs: string): Promise<string> {
  try {
    const st = await stat(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}
