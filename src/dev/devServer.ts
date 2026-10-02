// Development server: serves the webview bundle to a browser and runs RpcRouter against a real repository.
// For trying the UI and the git layer together without starting VS Code (not included in the VSIX).
//   node dist/dev/devServer.js --repo <path> [--port 5178] [--vscode-extensions <dir>]
// Syntax highlighting grammars and themes are read from the built-in extensions of an installed VS Code
// (--vscode-extensions, otherwise looked up from TWIGLINE_VSCODE_PATH and the usual install locations).
// Instead of postMessage, the webview -> host direction uses POST /rpc and host -> webview uses Server-Sent Events (/events).
// Pull requests are read with GITHUB_TOKEN (or GH_TOKEN) for GitHub, or BITBUCKET_EMAIL and BITBUCKET_API_TOKEN for Bitbucket Cloud,
// if set (public repositories only otherwise).

import { watch as fsWatch, readFileSync, existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Envelope, TwiglineConfig, HostEvent, RepoId, UiAction } from '../../shared/protocol';
import type { HostEnv } from '../host/HostEnv';
import { GitHelpers } from '../ipc/helpers';
import { RpcRouter } from '../panel/RpcRouter';
import { RepoModel } from '../repo/RepoModel';
import { SyntaxRegistry } from '../syntax/SyntaxRegistry';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const repoPath = path.resolve(opt('repo', process.cwd()));
const port = Number(opt('port', '5178'));
const extRoot = path.resolve(__dirname, '..', '..');
const webviewDir = path.join(extRoot, 'dist', 'webview');
const syntaxDir = path.join(extRoot, 'dist', 'syntax');

const config: TwiglineConfig = {
  historyOrder: 'date',
  historyBranches: 'all',
  showRemoteBranches: true,
  showStashes: false,
  pageSize: 500,
  dateFormat: 'absolute',
  graphColors: ['#2f6bd8', '#c0397f', '#c98410', '#2c9a58', '#7a4fd0', '#d0503a', '#1a93a8', '#8a8f1f'],
  fileStatusLayout: 'split',
  fileStatusView: 'list',
  contextLines: 3,
  ignoreWhitespace: false,
  maxDiffLines: 5000,
  syntaxHighlight: true,
  forcePushMode: 'withLease',
  rememberPushAfter: true,
  pullRequests: true,
  customActions: [],
};

const clients = new Set<http.ServerResponse>();
function broadcast(env: Envelope): void {
  const data = `data: ${JSON.stringify(env)}\n\n`;
  for (const c of clients) c.write(data);
}

const pendingEdits = new Map<string, (v: string | null) => void>();
const uiState = new Map<string, Record<string, unknown>>();

/** Find the folder of the built-in extensions of VS Code (resources/app/extensions) */
function findVscodeExtensions(): string | undefined {
  const explicit = opt('vscode-extensions', '');
  if (explicit) return path.resolve(explicit);
  const installs: string[] = [];
  if (process.env.TWIGLINE_VSCODE_PATH) installs.push(path.dirname(process.env.TWIGLINE_VSCODE_PATH));
  if (process.env.LOCALAPPDATA) installs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'));
  installs.push('C:\\Program Files\\Microsoft VS Code', '/Applications/Visual Studio Code.app/Contents', '/usr/share/code', '/opt/visual-studio-code');
  for (const dir of installs) {
    // Newer Windows builds have resources under a per-version folder (such as 04c0d99f4f)
    const bases = [dir];
    try {
      for (const d of readdirSync(dir)) bases.push(path.join(dir, d));
    } catch {
      continue;
    }
    for (const b of bases) {
      for (const rel of ['resources/app/extensions', 'Resources/app/extensions']) {
        const p = path.join(b, rel);
        if (existsSync(path.join(p, 'theme-defaults'))) return p;
      }
    }
  }
  return undefined;
}

let syntaxRegistry: SyntaxRegistry | undefined;
let currentTheme: 'dark' | 'light' = 'dark';
const vscodeExtensions = findVscodeExtensions();
if (vscodeExtensions) {
  syntaxRegistry = new SyntaxRegistry(SyntaxRegistry.scanDirectory(vscodeExtensions, (d) => readdirSync(d)));
  console.log(`[syntax] ${vscodeExtensions}`);
} else {
  console.log('[syntax] VS Code not found; diffs are shown without syntax highlighting (use --vscode-extensions <dir>)');
}

const env: HostEnv = {
  encodingFor: () => ({ encoding: 'utf8', autoGuess: true, language: 'ja' }),
  config: () => config,
  trash: async (paths) => {
    for (const p of paths) await rm(p, { recursive: true, force: true });
  },
  askpass: async (prompt) => {
    console.log(`[askpass] ${prompt.trim()} (no answer in dev server)`);
    return undefined;
  },
  logCommand: (e) => console.log(`[git] ${e.command} (${e.durationMs} ms, exit ${e.exitCode})${e.stderr ? '\n    ' + e.stderr.trim().split('\n').join('\n    ') : ''}`),
  showMessage: (kind, message) => console.log(`[${kind}] ${message}`),
  withProgress: (title, _c, task) => {
    console.log(`[progress] ${title}`);
    return task((m, p) => console.log(`[progress] ${m}${p !== undefined ? ` ${p}%` : ''}`), new AbortController().signal);
  },
  uiAction: async (_repo: RepoId, action: UiAction) => {
    console.log(`[ui] ${JSON.stringify(action).slice(0, 300)}`);
    if (action.kind === 'saveUiState') uiState.set(model.id, { ...(uiState.get(model.id) ?? {}), ...action.state });
    if (action.kind === 'openPullRequest') console.log(`[pr] ${model.pullRequests.last?.byRef[action.ref]?.url ?? '(no pull request)'}`);
    if (action.kind === 'pullRequestSignIn') {
      const vars = action.provider === 'github' ? 'GITHUB_TOKEN (or GH_TOKEN)' : 'BITBUCKET_EMAIL and BITBUCKET_API_TOKEN';
      console.log(`[pr] set ${vars} and restart the dev server to read private repositories`);
    }
  },
  watch: (dir, onChange) => {
    try {
      const w = fsWatch(dir, { recursive: true }, (_e, file) => file && onChange(path.join(dir, file.toString())));
      return { dispose: () => w.close() };
    } catch {
      return { dispose: () => undefined };
    }
  },
  getState: (repo) => uiState.get(repo) ?? {},
  setState: (repo, patch) => uiState.set(repo, { ...(uiState.get(repo) ?? {}), ...patch }),
  postEvent: (_repo, event: HostEvent) => broadcast({ t: 'evt', event }),
  editMessage: (_repo, title, initial) =>
    new Promise((resolve) => {
      const requestId = randomBytes(8).toString('hex');
      pendingEdits.set(requestId, resolve);
      broadcast({ t: 'evt', event: { type: 'ui/editMessage', requestId, title, initial } });
    }),
  syntax: syntaxRegistry && {
    language: (absPath, loaded) => syntaxRegistry!.resolve(absPath, loaded),
    theme: () => syntaxRegistry!.theme([currentTheme === 'dark' ? 'Dark Modern' : 'Light Modern'], currentTheme),
  },
  extensionPath: extRoot,
  helperExecPath: process.execPath,
  // Credentials for reading PRs come from environment variables (github.com and bitbucket.org only)
  pullRequestCredential: async (provider, host) => {
    const e = process.env;
    if (provider === 'github' && host === 'github.com' && (e.GITHUB_TOKEN || e.GH_TOKEN)) return { token: (e.GITHUB_TOKEN || e.GH_TOKEN)! };
    if (provider === 'bitbucket' && e.BITBUCKET_EMAIL && e.BITBUCKET_API_TOKEN) return { username: e.BITBUCKET_EMAIL, password: e.BITBUCKET_API_TOKEN };
    return undefined;
  },
};

let model: RepoModel;

/** Pass webview/context of package.json for the development right-click menu */
function menus(lang: string) {
  const pkg = JSON.parse(readFileSync(path.join(extRoot, 'package.json'), 'utf8'));
  const nlsFile = path.join(extRoot, lang === 'ja' ? 'package.nls.ja.json' : 'package.nls.json');
  const nls = JSON.parse(readFileSync(nlsFile, 'utf8')) as Record<string, string>;
  const titles = new Map<string, string>();
  for (const c of pkg.contributes.commands as { command: string; title: string }[]) {
    titles.set(c.command, c.title.replace(/^%(.+)%$/, (_m, k: string) => nls[k] ?? k));
  }
  return (pkg.contributes.menus['webview/context'] as { command: string; when: string; group: string }[]).map((m) => ({
    ...m,
    title: titles.get(m.command) ?? m.command,
  }));
}

function devHtml(lang: string, theme: string): string {
  const boot = JSON.stringify({ repo: model.id, root: model.root, dev: true, lang, syntaxWorker: '/syntax/worker.js' }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="${lang}" class="vscode-${theme}"><head><meta charset="UTF-8"><title>Twigline (dev) — ${model.name}</title>
<link rel="stylesheet" href="/dev-theme.css"><link rel="stylesheet" href="/index.css"></head>
<body class="vscode-${theme}" data-vscode-theme-kind="vscode-${theme}">
<div id="root"></div>
<script type="application/json" id="twigline-boot">${boot}</script>
<script type="module" src="/index.js"></script></body></html>`;
}

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.map': 'application/json', '.svg': 'image/svg+xml' };

async function main(): Promise<void> {
  const git = await RepoModel.detectGit(process.env.TWIGLINE_GIT ?? 'git');
  model = await RepoModel.open(repoPath, git, env, new GitHelpers(extRoot, process.execPath));
  model.startWatching(true);
  let currentLang = 'ja';
  const router = new RpcRouter(model, broadcast, {
    init: async () => ({
      repo: model.id,
      root: model.root,
      name: model.name,
      language: currentLang as 'ja' | 'en',
      platform: process.platform,
      config,
      uiState: uiState.get(model.id) ?? {},
    }),
    onEditMessageReply: (id, message) => {
      pendingEdits.get(id)?.(message);
      pendingEdits.delete(id);
    },
  });
  model.onDidChange((kinds) => broadcast({ t: 'evt', event: { type: 'repo/changed', repo: model.id, kinds } }));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          router.handle(JSON.parse(body));
        } catch (e) {
          console.error(e);
        }
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/menus') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(menus(currentLang)));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      currentLang = url.searchParams.get('lang') === 'en' ? 'en' : 'ja';
      const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
      if (theme !== currentTheme) {
        currentTheme = theme;
        broadcast({ t: 'evt', event: { type: 'syntax/changed' } });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(devHtml(currentLang, theme));
      return;
    }
    if (url.pathname === '/dev-theme.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' }).end(readFileSync(path.join(extRoot, 'webview', 'dev', 'theme.css')));
      return;
    }
    const [dir, rel] = url.pathname.startsWith('/syntax/') ? [syntaxDir, url.pathname.slice('/syntax'.length)] : [webviewDir, url.pathname];
    const file = path.join(dir, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (file.startsWith(dir) && existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(port, '127.0.0.1', () => console.log(`Twigline dev server: http://localhost:${port}/  (repo: ${model.root})`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
