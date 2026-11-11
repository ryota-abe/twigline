import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { OpResult, RebaseCommit, Sha, TodoItem } from '../../shared/protocol';
import { GitError } from '../git/errors';
import type { HelperEnv } from '../ipc/helpers';
import { ALL_KINDS, type RepoModel } from '../repo/RepoModel';
import type { RunOpOptions, Step } from './OpsService';

// Interactive rebase.
// The todo is replaced with the prepared content through the editor helper set as GIT_SEQUENCE_EDITOR.
// Messages for reword and squash are written through GIT_EDITOR; if not decided beforehand, the webview is asked.

interface RebaseContext {
  todoText: string;
  /** SHA -> new message (reword, squash) */
  messages: Map<Sha, string>;
}

const TODO_ACTIONS = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);

/**
 * git strips the lines that start with the comment character ('#') from a message that went through the editor, which is
 * every reworded or squashed message: a subject like "#123 Fix login" would vanish. A rebase Twigline starts therefore runs
 * with a comment character nobody types, so git's own hints are still stripped and every line of the message stays.
 */
const COMMENT_CHAR = '\x01';
const COMMENT_CONFIG = ['-c', `core.commentChar=${COMMENT_CHAR}`];
/** Marks a rebase started with COMMENT_CHAR, so that continuing it uses the same one (git removes it with rebase-merge) */
const COMMENT_MARKER = 'twigline-comment-char';

export function buildTodo(todo: TodoItem[]): string {
  const lines: string[] = [];
  for (const item of todo) {
    if (!TODO_ACTIONS.has(item.action)) throw new GitError('invalid', `Invalid action: ${item.action}`);
    if (!/^[0-9a-f]{4,64}$/i.test(item.sha)) throw new GitError('invalid', `Invalid commit: ${item.sha}`);
    const subject = item.subject.replace(/[\r\n]+/g, ' ');
    lines.push(`${item.action} ${item.sha} ${subject}`);
  }
  // git fails on this after it has started the rebase, and leaves it in progress with a todo it cannot run
  const first = todo.find((i) => i.action !== 'drop');
  if (first && (first.action === 'squash' || first.action === 'fixup')) {
    throw new GitError('invalid', 'The first commit that is kept cannot be squashed or fixed up');
  }
  return lines.join('\n') + '\n';
}

/** The message without comment lines (same as the strip git does after editing) */
export function stripComments(text: string, commentChar = '#'): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(commentChar))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

export class RebaseService {
  private context?: RebaseContext;

  constructor(private readonly repo: RepoModel) {}

  /** List of commits to show in the dialog (oldest first). When base is null, from the first commit */
  async commits(base: Sha | null): Promise<RebaseCommit[]> {
    if (base) await this.assertAncestor(base);
    const res = await this.repo.runner.run([
      'log',
      '--reverse',
      '--no-merges',
      '-z',
      '--encoding=UTF-8',
      '--format=%H%x1f%P%x1f%an%x1f%at%x1f%s%x1f%B',
      '--end-of-options',
      ...rangeOf(base),
      '--',
    ]);
    const list: RebaseCommit[] = [];
    for (const rec of res.stdout.toString('utf8').split('\0')) {
      const r = rec.replace(/^\n/, '');
      if (!r) continue;
      const [sha, parents, author, at, subject, ...body] = r.split('\x1f');
      list.push({
        sha,
        subject,
        message: body.join('\x1f').replace(/\n+$/, ''),
        author,
        authorTime: Number(at) || 0,
        isMerge: (parents ?? '').split(' ').filter(Boolean).length > 1,
      });
    }
    return list;
  }

  /**
   * A base that is not an ancestor of HEAD (a commit of another branch) would not edit the commits after it: git would move
   * the whole branch onto that commit instead
   */
  private async assertAncestor(base: Sha): Promise<void> {
    const res = await this.repo.runner.run(['merge-base', '--is-ancestor', base, 'HEAD'], { noThrow: true });
    if (res.exitCode !== 0) throw new GitError('invalid', `${base.slice(0, 7)} is not an ancestor of HEAD, so the commits after it cannot be rebased interactively`);
  }

  /**
   * The todo must name exactly the commits after the base. When HEAD has moved since the dialog listed them (a commit made
   * meanwhile), the commits missing from the todo would be dropped without a word
   */
  private async assertTodoCurrent(base: Sha | null, todo: TodoItem[]): Promise<void> {
    if (base) await this.assertAncestor(base);
    const res = await this.repo.runner.run(['rev-list', '--no-merges', '--end-of-options', ...rangeOf(base), '--']);
    const now = res.stdout.toString('utf8').split('\n').filter(Boolean);
    const listed = new Set(todo.map((i) => i.sha.toLowerCase()));
    if (now.length !== listed.size || now.some((s) => !listed.has(s))) {
      throw new GitError('invalid', 'The commits to rebase have changed since they were listed. Open the interactive rebase again');
    }
  }

  plan(base: Sha | null, todo: TodoItem[]): Step[] {
    const todoText = buildTodo(todo);
    const args = ['rebase', '-i', ...(base ? ['--end-of-options', base] : ['--root'])];
    return [
      { type: 'git', args, queue: 'write', rebaseEditor: true },
      { type: 'fn', describe: `# todo:\n${todoText.trimEnd()}`, run: async () => undefined },
    ];
  }

  async run(base: Sha | null, todo: TodoItem[], opts: RunOpOptions): Promise<OpResult> {
    if (base !== null && !/^[0-9a-f]{4,64}$/i.test(base)) throw new GitError('invalid', `Invalid commit: ${base}`);
    const todoText = buildTodo(todo);
    const messages = new Map<Sha, string>();
    for (const item of todo) {
      if ((item.action === 'reword' || item.action === 'squash') && item.message?.trim()) messages.set(item.sha, item.message);
    }
    this.context = { todoText, messages };
    const shown = ['rebase', '-i', ...(base ? ['--end-of-options', base] : ['--root'])];
    const args = [...COMMENT_CONFIG, ...shown];
    return this.repo.runOp(ALL_KINDS, async () => {
      await this.assertTodoCurrent(base, todo);
      const ed = await this.editorEnv(true);
      try {
        await this.repo.runner.run(args, { queue: 'write', env: ed.env, signal: opts.signal });
      } finally {
        ed.dispose();
        if (!this.repo.snapshot.readSequence()) this.context = undefined;
      }
      const stopped = this.repo.snapshot.readSequence() !== null;
      return { commands: [`git ${shown.join(' ')}`], stopped: stopped || undefined };
    });
  }

  /** Whether the rebase in progress was started by Twigline, with its own comment character */
  private ownsRebase(): boolean {
    return existsSync(path.join(this.repo.gitDir, 'rebase-merge', COMMENT_MARKER));
  }

  /** Options that go before `rebase` to continue the rebase in progress the way it was started */
  configArgs(): string[] {
    return this.ownsRebase() ? COMMENT_CONFIG : [];
  }

  /** Environment variables that make GIT_EDITOR (and GIT_SEQUENCE_EDITOR at the start) the editor helper */
  editorEnv(sequence = false): Promise<HelperEnv> {
    return this.repo.helpers.editorEnv({ editor: (file) => this.onEditor(file) }, { sequence });
  }

  private async onEditor(file: string): Promise<boolean> {
    const base = path.basename(file);
    if (base === 'git-rebase-todo') {
      if (!this.context) return false; // Abort if there is no prepared todo
      await writeFile(file, this.context.todoText, 'utf8');
      await writeFile(path.join(path.dirname(file), COMMENT_MARKER), '', 'utf8');
      return true;
    }
    // Editing commit messages (reword, squash, amend after edit)
    const content = await readFile(file, 'utf8').catch(() => '');
    const done = await readFile(path.join(this.repo.gitDir, 'rebase-merge', 'done'), 'utf8').catch(() => '');
    const steps = done
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const [action, sha] = l.split(/\s+/);
        return { action: normalizeAction(action), sha: sha ?? '' };
      });
    const last = steps[steps.length - 1];
    if (!last) return true;

    const lookup = (sha: string) => {
      if (!this.context) return undefined;
      for (const [k, v] of this.context.messages) if (k.startsWith(sha) || sha.startsWith(k)) return v;
      return undefined;
    };

    if (last.action === 'reword') {
      const msg = lookup(last.sha);
      if (msg !== undefined) {
        await writeFile(file, msg.trimEnd() + '\n', 'utf8');
        return true;
      }
      return this.askWebview(file, 'Reword commit message', content);
    }
    if (last.action === 'squash' || last.action === 'fixup') {
      // Among consecutive squash / fixup entries, look for the message starting from the last one
      for (let i = steps.length - 1; i >= 0 && (steps[i].action === 'squash' || steps[i].action === 'fixup'); i--) {
        const msg = lookup(steps[i].sha);
        if (msg !== undefined) {
          await writeFile(file, msg.trimEnd() + '\n', 'utf8');
          return true;
        }
      }
      return this.askWebview(file, 'Combined commit message', content);
    }
    return true;
  }

  private async askWebview(file: string, title: string, content: string): Promise<boolean> {
    const edited = await this.repo.env.editMessage(this.repo.id, title, stripComments(content, this.ownsRebase() ? COMMENT_CHAR : '#'));
    if (edited === null) return true; // If cancelled, go on with git's default message
    await writeFile(file, edited.trimEnd() + '\n', 'utf8');
    return true;
  }
}

function rangeOf(base: Sha | null): string[] {
  return base ? [`${base}..HEAD`] : ['HEAD'];
}

function normalizeAction(a: string | undefined): string {
  switch (a) {
    case 'p':
      return 'pick';
    case 'r':
      return 'reword';
    case 'e':
      return 'edit';
    case 's':
      return 'squash';
    case 'f':
      return 'fixup';
    case 'd':
      return 'drop';
    default:
      return a ?? '';
  }
}
