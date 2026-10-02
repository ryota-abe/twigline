import { useEffect, useState, useSyncExternalStore } from 'react';
import type { FileDiff } from '../../../shared/protocol';
import { getRpc } from '../store/actions';
import { get } from '../store/store';
import { diffBlocks, tokensByLine, type Tok } from './tokens';
import type { WorkerRequest, WorkerResponse } from './worker';

// Communication with the syntax highlighting Worker.
// The Worker script lives at a different origin from the webview (vscode-resource), so it cannot be started with new Worker as is;
// fetch its body and start it from a blob: URL. If anything fails, show without highlighting.

/** Upper limit of the wait until the Worker starts and responds */
const PING_TIMEOUT_MS = 10_000;

let worker: Promise<Worker | null> | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (v: Tok[][][]) => void; reject: (e: Error) => void }>();

/** Key of the current theme (loaded in the Worker). null means the theme could not be obtained */
let themeKey: Promise<string | null> | undefined;
/** Path -> language ID */
const langOfPath = new Map<string, Promise<string | null>>();
/** Languages whose grammars were sent to the Worker */
const loadedLangs = new Set<string>();

let version = 0;
const listeners = new Set<() => void>();

function post(w: Worker, msg: WorkerRequest): void {
  w.postMessage(msg);
}

function request(w: Worker, make: (id: number) => WorkerRequest, timeoutMs?: number): Promise<Tok[][][]> {
  const id = nextId++;
  return new Promise<Tok[][][]>((resolve, reject) => {
    const timer = timeoutMs ? setTimeout(() => pending.get(id)?.reject(new Error('Syntax worker did not respond')), timeoutMs) : undefined;
    const done = () => {
      pending.delete(id);
      if (timer) clearTimeout(timer);
    };
    pending.set(id, {
      resolve: (v) => (done(), resolve(v)),
      reject: (e) => (done(), reject(e)),
    });
    post(w, make(id));
  });
}

function startWorker(): Promise<Worker | null> {
  worker ??= (async () => {
    const url = get().boot.syntaxWorker;
    if (!url || typeof Worker === 'undefined') return null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = new Blob([await res.text()], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const r = e.data;
        const p = pending.get(r.id);
        if (!p) return;
        if (r.ok) p.resolve(r.result);
        else p.reject(new Error(r.error));
      };
      w.onerror = (e) => {
        console.error('[twigline] syntax worker failed', e.message);
        for (const p of [...pending.values()]) p.reject(new Error(e.message));
      };
      await request(w, (id) => ({ t: 'ping', id }), PING_TIMEOUT_MS);
      return w;
    } catch (e) {
      console.warn('[twigline] syntax highlighting is unavailable', e);
      return null;
    }
  })();
  return worker;
}

function ensureTheme(w: Worker): Promise<string | null> {
  themeKey ??= getRpc()
    .request('syntax/theme', {})
    .then((theme) => {
      if (!theme) return null;
      post(w, { t: 'theme', theme });
      return theme.key;
    })
    .catch(() => null);
  return themeKey;
}

function ensureLanguage(w: Worker, path: string): Promise<string | null> {
  let p = langOfPath.get(path);
  if (!p) {
    p = getRpc()
      .request('syntax/language', { path, loaded: [...loadedLangs] })
      .then((lang) => {
        if (!lang) return null;
        if (!loadedLangs.has(lang.id)) {
          if (lang.grammars.length === 0) return null;
          loadedLangs.add(lang.id);
          post(w, { t: 'lang', lang });
        }
        return lang.id;
      })
      .catch(() => null);
    langOfPath.set(path, p);
  }
  return p;
}

/** Tokens of each line in a diff. null when it cannot be colored */
export async function highlightDiff(diff: FileDiff): Promise<Map<number, Tok[]> | null> {
  if (diff.binary || diff.image || diff.hunks.length === 0) return null;
  const w = await startWorker();
  if (!w) return null;
  const [theme, lang] = await Promise.all([ensureTheme(w), ensureLanguage(w, diff.path)]);
  if (!theme || !lang) return null;
  const { blocks, where } = diffBlocks(diff);
  const result = await request(w, (id) => ({ t: 'tokenize', id, lang, theme, blocks }));
  return tokensByLine(diff, where, result);
}

/** The theme or extensions changed (syntax/changed from the host). Drop what was loaded and color again */
export function onSyntaxChanged(): void {
  themeKey = undefined;
  langOfPath.clear();
  loadedLangs.clear();
  void worker?.then((w) => w && post(w, { t: 'reset' }));
  version++;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Syntax highlighting of diffs. Show without color first, then apply colors when the Worker's result arrives.
 * After the theme changes, keep showing the old colors until the new result arrives.
 */
export function useSyntax(diff: FileDiff, enabled: boolean): Map<number, Tok[]> | null {
  const v = useSyncExternalStore(subscribe, () => version);
  const [state, setState] = useState<{ diff: FileDiff; tokens: Map<number, Tok[]> | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    highlightDiff(diff).then(
      (tokens) => alive && setState({ diff, tokens }),
      (e) => {
        console.warn('[twigline] syntax highlighting failed', e);
        if (alive) setState({ diff, tokens: null });
      },
    );
    return () => {
      alive = false;
    };
  }, [diff, enabled, v]);
  return enabled && state?.diff === diff ? state.tokens : null;
}
