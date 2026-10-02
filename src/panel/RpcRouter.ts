import type { Envelope, InitData, RpcMethod, RpcMethods } from '../../shared/protocol';
import { GitError, toRpcError } from '../git/errors';
import type { RepoModel } from '../repo/RepoModel';
import { methodParams } from './schemas';

// Validates incoming messages (zod) and calls the services.
// Each request has an AbortController; on cancel, the corresponding git process is terminated.

type Handler<M extends RpcMethod> = (params: Parameters<RpcMethods[M]>[0], ctx: { signal: AbortSignal; id: number }) => Promise<ReturnType<RpcMethods[M]>>;

export interface RouterHooks {
  init(): Promise<InitData & { uiState: Record<string, unknown> }>;
  onEditMessageReply(requestId: string, message: string | null): void;
}

export class RpcRouter {
  private readonly inflight = new Map<number, AbortController>();
  private readonly handlers: { [M in RpcMethod]: Handler<M> };
  /** Number of requests handled per method (for integration tests and diagnostics) */
  readonly stats = new Map<string, { ok: number; failed: number }>();

  constructor(
    private readonly repo: RepoModel,
    private readonly post: (env: Envelope) => void,
    hooks: RouterHooks,
  ) {
    const r = repo;
    this.handlers = {
      'app/init': () => hooks.init(),
      // The webview asks for the state on change notifications and reloads, so re-fetch without using the cache
      'repo/snapshot': () => {
        r.snapshot.invalidate();
        return r.snapshot.get();
      },
      'repo/resolve': async (p) => {
        const res = await r.runner.run(['rev-parse', '-q', '--verify', '--end-of-options', `${p.rev}^{commit}`], { noThrow: true });
        return res.exitCode === 0 ? res.stdout.toString('utf8').trim() : null;
      },
      'ref/validate': async (p) => {
        if (!p.name || p.name.startsWith('-')) return { valid: false };
        const res = await r.runner.run(['check-ref-format', '--branch', p.name], { noThrow: true });
        return { valid: res.exitCode === 0 };
      },
      'log/page': (p, c) => r.log.page(p.query, p.cursor, p.offset, p.limit, c.signal),
      'commit/detail': (p, c) => r.diff.commitDetail(p.sha, p.compareTo, p.parent, c.signal),
      'commit/info': () => r.commit.info(),
      'diff/file': (p, c) => r.diff.get(p, c.signal),
      'status/get': () => {
        r.status.invalidate();
        return r.status.get();
      },
      'stage/paths': async (p) => (p.action === 'stage' ? r.stage.stagePaths(p.paths) : r.stage.unstagePaths(p.paths)),
      'stage/lines': (p) => r.stage.applyLines(p.diffId, p.lineIds, p.action),
      'commit/create': (p) => r.commit.create(p),
      'op/run': async (p, c) => {
        const opId = String(c.id);
        try {
          const result = await r.ops.run(p.op, { dryRun: p.dryRun, interactive: true, signal: c.signal, opId });
          if (!p.dryRun) this.post({ t: 'evt', event: { type: 'op/finished', opId, ok: true } });
          return result;
        } catch (e) {
          if (!p.dryRun) this.post({ t: 'evt', event: { type: 'op/finished', opId, ok: false } });
          throw e;
        }
      },
      'rebase/commits': (p) => r.rebase.commits(p.base),
      'pr/list': (p) => r.pullRequests.list(p.force),
      'ui/action': (p) => r.env.uiAction(r.id, p.action),
      'ui/editMessageReply': async (p) => hooks.onEditMessageReply(p.requestId, p.message),
      'syntax/language': async (p) => (r.env.syntax ? r.env.syntax.language(r.resolvePath(p.path), p.loaded) : null),
      'syntax/theme': async () => (r.env.syntax ? r.env.syntax.theme() : null),
    };
  }

  handle(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const env = msg as Envelope;
    if (env.t === 'cancel' && typeof env.id === 'number') {
      this.inflight.get(env.id)?.abort();
      return;
    }
    if (env.t !== 'req' || typeof env.id !== 'number') return;
    void this.dispatch(env.id, env.method, env.params);
  }

  private async dispatch(id: number, method: RpcMethod, rawParams: unknown): Promise<void> {
    const schema = methodParams[method];
    const handler = this.handlers[method] as Handler<RpcMethod> | undefined;
    if (!schema || !handler) {
      this.post({ t: 'res', id, ok: false, error: { category: 'invalid', message: `Unknown method: ${String(method)}` } });
      return;
    }
    const parsed = schema.safeParse(rawParams);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.post({
        t: 'res',
        id,
        ok: false,
        error: { category: 'invalid', message: `Invalid parameters for ${method}: ${issue?.path.join('.')} ${issue?.message}` },
      });
      return;
    }
    const params = parsed.data as { repo?: string };
    if (params.repo !== undefined && params.repo !== this.repo.id) {
      this.post({ t: 'res', id, ok: false, error: { category: 'invalid', message: 'Repository mismatch' } });
      return;
    }
    const ctrl = new AbortController();
    this.inflight.set(id, ctrl);
    const stat = this.stats.get(method) ?? { ok: 0, failed: 0 };
    this.stats.set(method, stat);
    try {
      const result = await handler(parsed.data as never, { signal: ctrl.signal, id });
      this.post({ t: 'res', id, ok: true, result: result ?? null });
      stat.ok++;
    } catch (e) {
      const err = ctrl.signal.aborted ? new GitError('cancelled', 'Cancelled') : e;
      this.post({ t: 'res', id, ok: false, error: toRpcError(err) });
      stat.failed++;
    } finally {
      this.inflight.delete(id);
    }
  }

  dispose(): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
  }
}
