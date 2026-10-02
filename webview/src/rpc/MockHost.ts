import type { Envelope, HostEvent, RpcMethod, RpcMethods } from '../../../shared/protocol';
import type { Transport } from './RpcClient';

// Stand-in for the host in tests (RpcClient is replaced by MockHost in tests).
// Registers a response function per method and answers requests from the webview.

type Handlers = { [M in RpcMethod]?: (params: Parameters<RpcMethods[M]>[0]) => ReturnType<RpcMethods[M]> | Promise<ReturnType<RpcMethods[M]>> };

export class MockHost implements Transport {
  readonly calls: { method: RpcMethod; params: unknown }[] = [];
  private listener?: (env: Envelope) => void;
  private state: unknown;

  constructor(private readonly handlers: Handlers) {}

  post(env: Envelope): void {
    if (env.t !== 'req') return;
    this.calls.push({ method: env.method, params: env.params });
    const handler = this.handlers[env.method] as ((p: unknown) => unknown) | undefined;
    void Promise.resolve()
      .then(() => {
        if (!handler) throw new Error(`MockHost: no handler for ${env.method}`);
        return handler(env.params);
      })
      .then(
        (result) => this.listener?.({ t: 'res', id: env.id, ok: true, result: result ?? null }),
        (e: unknown) =>
          this.listener?.({
            t: 'res',
            id: env.id,
            ok: false,
            error: typeof e === 'object' && e && 'category' in e ? (e as never) : { category: 'unknown', message: String(e) },
          }),
      );
  }

  onMessage(fn: (env: Envelope) => void): void {
    this.listener = fn;
  }

  setState(state: unknown): void {
    this.state = state;
  }

  getState(): unknown {
    return this.state;
  }

  /** Send a notification from the host */
  emit(event: HostEvent): void {
    this.listener?.({ t: 'evt', event });
  }

  count(method: RpcMethod): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}
