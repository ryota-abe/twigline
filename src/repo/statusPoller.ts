import { statSync } from 'node:fs';
import * as path from 'node:path';
import type { ParsedStatus } from '../git/parsers/status';

// Noticing working tree changes of a repository vscode.git does not know (one outside the workspace) without watching its folder:
// `git status` is read again on events (the host decides which) and every few seconds while the panel is in use, and the panel is
// told only when the result differs. A watcher of a folder outside the workspace uses up inotify watches on Linux and may miss
// changes on network drives; reading status works everywhere.
// (This file does not import vscode)

export interface StatusPollerOptions {
  /** Read the state and return its fingerprint. undefined skips this time (a write operation is running, say) */
  read: () => Promise<string | undefined>;
  /** The fingerprint differs from the last one */
  onChange: () => void;
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
  /** An event came while reading: read once more right after */
  private again = false;
  /** The next read only takes a new baseline (see resync) */
  private silent = false;
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
    if (active) this.schedule(this.debounceMs, true);
    else if (!this.timerForEvent) this.clear();
  }

  /** Something may have changed (a file was saved in VS Code, say): read soon, active or not */
  poke(): void {
    if (this.disposed) return;
    if (this.running) this.again = true;
    else this.schedule(this.debounceMs, true);
  }

  /**
   * The panel was told about a change some other way (a Twigline operation, the .git watcher) and reads the status itself:
   * take the new state as the baseline without telling it again
   */
  resync(): void {
    this.silent = true;
    this.poke();
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
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    const start = Date.now();
    let fingerprint: string | undefined;
    try {
      fingerprint = await this.opts.read();
    } catch {
      fingerprint = undefined;
    }
    const took = Date.now() - start;
    this.running = false;
    if (this.disposed) return;
    if (fingerprint !== undefined) {
      // The first read is the baseline: the panel reads the status itself when it opens
      const changed = !this.silent && this.last !== undefined && fingerprint !== this.last;
      // A resync that came while reading is done by the next read
      if (!this.again) this.silent = false;
      this.last = fingerprint;
      if (changed) this.opts.onChange();
    }
    if (this.again) {
      this.again = false;
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
const MAX_STAT_FILES = 1000;

/**
 * What the Uncommitted Changes tab shows, as a string: the branch, the changed files and their status, and the time and size of the
 * index and of each changed file in the working tree (so editing a file that is already modified, which keeps its status, is noticed
 * and its diff is read again).
 */
export function statusFingerprint(root: string, gitDir: string, s: ParsedStatus): string {
  let statted = 0;
  const fileStat = (rel: string) => (statted++ < MAX_STAT_FILES ? stat(path.join(root, rel)) : '');
  const files = [
    ...s.conflicted.map((f) => ['C', f.path, f.conflict ?? '', fileStat(f.path)]),
    ...s.unstaged.map((f) => ['U', f.path, f.status, fileStat(f.path)]),
    // Staged changes are in the index, whose time and size stand for them
    ...s.staged.map((f) => ['S', f.path, f.status]),
  ];
  return JSON.stringify({ branch: s.branch, index: stat(path.join(gitDir, 'index')), files });
}

function stat(abs: string): string {
  try {
    const st = statSync(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}
