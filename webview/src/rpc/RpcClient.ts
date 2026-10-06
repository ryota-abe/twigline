import type { Envelope, GitErrorCategory, HostEvent, RpcError as RpcErrorShape, RpcMethod, RpcParams, RpcResult } from '../../../shared/protocol';

// RPC on the webview side. Gives each request an ID and sends cancel for old requests when the selection changes.

export interface Transport {
  post(env: Envelope): void;
  onMessage(fn: (env: Envelope) => void): void;
  /** State for WebviewPanelSerializer */
  setState(state: unknown): void;
  getState(): unknown;
}

export class RpcError extends Error implements RpcErrorShape {
  readonly category: GitErrorCategory;
  readonly command?: string;
  readonly stderr?: string;
  readonly files?: string[];
  readonly sequenceStopped?: boolean;
  constructor(e: RpcErrorShape) {
    super(e.message);
    this.name = 'RpcError';
    this.category = e.category;
    this.command = e.command;
    this.stderr = e.stderr;
    this.files = e.files;
    this.sequenceStopped = e.sequenceStopped;
  }
}

export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly listeners = new Set<(e: HostEvent) => void>();

  constructor(readonly transport: Transport) {
    transport.onMessage((env) => this.onMessage(env));
  }

  request<M extends RpcMethod>(method: M, params: RpcParams<M>, signal?: AbortSignal): Promise<RpcResult<M>> {
    const id = this.nextId++;
    return new Promise<RpcResult<M>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RpcError({ category: 'cancelled', message: 'Cancelled' }));
        return;
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.transport.post({ t: 'cancel', id });
          reject(new RpcError({ category: 'cancelled', message: 'Cancelled' }));
        },
        { once: true },
      );
      this.transport.post({ t: 'req', id, method, params });
    });
  }

  onEvent(fn: (e: HostEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onMessage(env: Envelope): void {
    if (!env || typeof env !== 'object') return;
    if (env.t === 'res') {
      const p = this.pending.get(env.id);
      if (!p) return;
      this.pending.delete(env.id);
      if (env.ok) p.resolve(env.result);
      else p.reject(new RpcError(env.error));
      return;
    }
    if (env.t === 'evt') {
      for (const l of [...this.listeners]) {
        try {
          l(env.event);
        } catch (e) {
          console.error('[twigline] event handler failed', e);
        }
      }
    }
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof RpcError && e.category === 'cancelled';
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}
declare function acquireVsCodeApi(): VsCodeApi;

export function vscodeTransport(): Transport {
  const api = acquireVsCodeApi();
  return {
    post: (env) => api.postMessage(env),
    onMessage: (fn) => window.addEventListener('message', (e: MessageEvent) => fn(e.data as Envelope)),
    setState: (s) => api.setState(s),
    getState: () => api.getState(),
  };
}

/** Development server: requests are POST /rpc; responses and notifications are Server-Sent Events */
export function devTransport(): Transport {
  const handlers: ((env: Envelope) => void)[] = [];
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const env = JSON.parse(e.data) as Envelope;
    for (const h of handlers) h(env);
  };
  // Responses arrive over SSE, so do not send requests until the connection is open (so the first response is not missed)
  const opened = new Promise<void>((resolve) => es.addEventListener('open', () => resolve(), { once: true }));
  let state: unknown;
  return {
    post: (env) =>
      void opened.then(() => fetch('/rpc', { method: 'POST', body: JSON.stringify(env), headers: { 'Content-Type': 'application/json' } })),
    onMessage: (fn) => handlers.push(fn),
    setState: (s) => (state = s),
    getState: () => state,
  };
}

export function isVsCode(): boolean {
  return typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function';
}
