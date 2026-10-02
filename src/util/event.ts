/** A small event that does not depend on vscode.EventEmitter (also used by the development server and tests) */
export type Listener<T> = (e: T) => void;

export interface Disposable {
  dispose(): void;
}

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error('[twigline] listener failed', err);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export function debounce(fn: () => void, ms: number): { (): void; cancel(): void; flush(): void } {
  let timer: NodeJS.Timeout | undefined;
  const wrapped = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      fn();
    }
  };
  return wrapped;
}
