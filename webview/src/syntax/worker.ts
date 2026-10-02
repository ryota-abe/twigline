import type { SyntaxLanguage, SyntaxTheme } from '../../../shared/protocol';
import { SyntaxEngine } from './engine';
import type { Tok } from './tokens';

// Web Worker for syntax highlighting. scripts/build.mjs bundles it alone into dist/syntax/worker.js.
// Requests are handled one at a time in the order they arrive (so loading the theme and languages finishes before coloring).

export type WorkerRequest =
  | { t: 'theme'; theme: SyntaxTheme }
  | { t: 'lang'; lang: SyntaxLanguage }
  | { t: 'tokenize'; id: number; lang: string; theme: string; blocks: string[][] }
  | { t: 'reset' }
  /** Startup check. Keeps coloring from waiting forever when the Worker cannot run because of the CSP or the like */
  | { t: 'ping'; id: number };

export type WorkerResponse = { id: number; ok: true; result: Tok[][][] } | { id: number; ok: false; error: string };

const engine = new SyntaxEngine();
let chain: Promise<void> = Promise.resolve();
// The webview's tsconfig uses DOM types, so only the needed parts of the Worker's global object are typed
const ctx = self as unknown as { onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null; postMessage(msg: WorkerResponse): void };

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  chain = chain.then(() => handle(msg)).catch((err) => console.error('[twigline] syntax worker', err));
};

async function handle(msg: WorkerRequest): Promise<void> {
  switch (msg.t) {
    case 'theme':
      await engine.loadTheme(msg.theme);
      return;
    case 'lang':
      await engine.loadLanguage(msg.lang);
      return;
    case 'reset':
      engine.reset();
      return;
    case 'ping':
      ctx.postMessage({ id: msg.id, ok: true, result: [] });
      return;
    case 'tokenize': {
      let res: WorkerResponse;
      try {
        res = { id: msg.id, ok: true, result: await engine.tokenize(msg.lang, msg.theme, msg.blocks) };
      } catch (err) {
        res = { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      ctx.postMessage(res);
      return;
    }
  }
}
