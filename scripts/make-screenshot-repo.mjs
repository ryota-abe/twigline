// Creates the repository shown in the README screenshot: a small TypeScript app with a few people working on it
//   node scripts/make-screenshot-repo.mjs <dir>
// Feature branches merged by pull request, branches in progress (pushed and local), a release branch, tags, a stash,
// and main one commit ahead of origin. See "Screenshot" in CONTRIBUTING.md for taking the screenshot.
// origin is a GitHub URL (https://github.com/example/inkwell.git) that url.<dir>.insteadOf points to a local bare repository
// (<dir>-origin.git), and <dir>-pulls.json holds its pull requests for the development server (--pull-requests).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'screenshot-repo');
const remoteDir = dir + '-origin.git';
const pullsFile = dir + '-pulls.json';
const remoteUrl = 'https://github.com/example/inkwell.git';
for (const d of [dir, remoteDir]) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const people = {
  maya: ['Maya Chen', 'maya.chen@example.com', '-0700'],
  daniel: ['Daniel Okafor', 'daniel.okafor@example.com', '+0100'],
  sofia: ['Sofia Rossi', 'sofia.rossi@example.com', '+0200'],
  kenji: ['Kenji Watanabe', 'kenji.watanabe@example.com', '+0900'],
};
// About ten days of work ending yesterday
let clock = Math.floor(Date.now() / 1000) - 10 * 86400;
let who = people.maya;

function git(args, opts = {}) {
  const [name, email, tz] = who;
  const date = `${clock} ${tz}`;
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd: opts.cwd ?? dir,
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}
function write(rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
/** Advance the clock by about `hours` (a little randomness keeps the times from looking generated) */
function later(hours) {
  clock += Math.round(hours * 2.5 * 3600 + (Math.random() - 0.5) * 1200);
}
function commit(person, msg, files = {}, hours = 3) {
  who = person;
  later(hours);
  for (const [k, v] of Object.entries(files)) write(k, v);
  git(['add', '-A']);
  git(['commit', '-q', '--allow-empty', '-m', msg]);
}
function merge(person, branch, msg, hours = 1) {
  who = person;
  later(hours);
  git(['merge', '-q', '--no-ff', '-m', msg, branch]);
}
const checkout = (...args) => git(['checkout', '-q', ...args]);
const lines = (...l) => l.join('\n') + '\n';

// --- Files ---------------------------------------------------------------------------------------------------------

const pkg = (version) =>
  JSON.stringify(
    {
      name: 'inkwell',
      version,
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'tsc -b && vite build', test: 'vitest run', lint: 'eslint src' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', zustand: '^4.5.5' },
      devDependencies: { typescript: '^5.6.2', vite: '^5.4.8', vitest: '^2.1.2' },
    },
    null,
    2,
  ) + '\n';

const searchV1 = lines(
  "import { useEffect, useState } from 'react';",
  "import { api } from '../api/client';",
  "import type { Note } from '../model/note';",
  '',
  'export function useSearch(query: string) {',
  '  const [results, setResults] = useState<Note[]>([]);',
  '  const [loading, setLoading] = useState(false);',
  '',
  '  useEffect(() => {',
  '    if (!query.trim()) {',
  '      setResults([]);',
  '      return;',
  '    }',
  '    setLoading(true);',
  '    api',
  "      .get<Note[]>('/notes/search', { q: query })",
  '      .then(setResults)',
  '      .finally(() => setLoading(false));',
  '  }, [query]);',
  '',
  '  return { results, loading };',
  '}',
);

const searchV2 = lines(
  "import { useEffect, useState } from 'react';",
  "import { api } from '../api/client';",
  "import type { Note } from '../model/note';",
  '',
  '/** Wait this long after the last keystroke before searching */',
  'const DEBOUNCE_MS = 250;',
  '',
  'export function useSearch(query: string) {',
  '  const [results, setResults] = useState<Note[]>([]);',
  '  const [loading, setLoading] = useState(false);',
  '',
  '  useEffect(() => {',
  '    if (!query.trim()) {',
  '      setResults([]);',
  '      return;',
  '    }',
  '    // Cancel the request of an older query so its results never replace newer ones',
  '    const controller = new AbortController();',
  '    const timer = setTimeout(() => {',
  '      setLoading(true);',
  '      api',
  "        .get<Note[]>('/notes/search', { q: query }, controller.signal)",
  '        .then(setResults)',
  "        .catch((e) => e.name !== 'AbortError' && console.error(e))",
  '        .finally(() => setLoading(false));',
  '    }, DEBOUNCE_MS);',
  '    return () => {',
  '      clearTimeout(timer);',
  '      controller.abort();',
  '    };',
  '  }, [query]);',
  '',
  '  return { results, loading };',
  '}',
);

const clientV1 = lines(
  "const BASE_URL = import.meta.env.VITE_API_URL ?? '/api';",
  '',
  'async function request<T>(method: string, path: string, body?: unknown): Promise<T> {',
  '  const res = await fetch(BASE_URL + path, {',
  '    method,',
  "    headers: { 'Content-Type': 'application/json' },",
  '    body: body === undefined ? undefined : JSON.stringify(body),',
  '  });',
  '  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);',
  '  return res.json() as Promise<T>;',
  '}',
  '',
  'export const api = {',
  "  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', query ? `${path}?${new URLSearchParams(query)}` : path),",
  "  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),",
  "  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),",
  "  delete: (path: string) => request<void>('DELETE', path),",
  '};',
);

const clientV2 = clientV1
  .replace(
    'async function request<T>(method: string, path: string, body?: unknown): Promise<T> {',
    'async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {',
  )
  .replace('    method,\n', '    method,\n    signal,\n')
  .replace(
    "  get: <T>(path: string, query?: Record<string, string>) => request<T>('GET', query ? `${path}?${new URLSearchParams(query)}` : path),",
    "  get: <T>(path: string, query?: Record<string, string>, signal?: AbortSignal) =>\n    request<T>('GET', query ? `${path}?${new URLSearchParams(query)}` : path, undefined, signal),",
  );

const note = lines(
  'export interface Note {',
  '  id: string;',
  '  title: string;',
  '  body: string;',
  '  tags: string[];',
  '  updatedAt: string;',
  '}',
);

const store = (extra = '') =>
  lines(
    "import { create } from 'zustand';",
    "import type { Note } from './note';",
    '',
    'interface NotesState {',
    '  notes: Record<string, Note>;',
    '  selected: string | null;',
    '  select: (id: string | null) => void;',
    '  upsert: (note: Note) => void;',
    '  remove: (id: string) => void;' + extra,
    '}',
    '',
    'export const useNotes = create<NotesState>((set) => ({',
    '  notes: {},',
    '  selected: null,',
    '  select: (id) => set({ selected: id }),',
    '  upsert: (note) => set((s) => ({ notes: { ...s.notes, [note.id]: note } })),',
    '  remove: (id) =>',
    '    set((s) => {',
    '      const { [id]: _, ...rest } = s.notes;',
    '      return { notes: rest, selected: s.selected === id ? null : s.selected };',
    '    }),',
    '}));',
  );

const formatDate = (fixed) => {
  const tz = fixed ? ', timeZone' : '';
  return lines(
    '/** "Today 14:05", "Yesterday 09:12" or "Mar 3, 2025" in the user\'s locale */',
    `export function formatUpdated(iso: string, now = new Date()${fixed ? ', timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone' : ''}): string {`,
    '  const date = new Date(iso);',
    `  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit'${tz} });`,
    '  const days = Math.floor((startOfDay(now) - startOfDay(date)) / 86_400_000);',
    '  if (days === 0) return `Today ${time}`;',
    '  if (days === 1) return `Yesterday ${time}`;',
    `  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric'${tz} });`,
    '}',
    '',
    'function startOfDay(d: Date): number {',
    '  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();',
    '}',
  );
};

// --- History -------------------------------------------------------------------------------------------------------

const { maya, daniel, sofia, kenji } = people;
git(['init', '-q']);
git(['config', 'core.autocrlf', 'false']);
git(['config', 'user.name', maya[0]]);
git(['config', 'user.email', maya[1]]);

commit(maya, 'Set up Vite, React and TypeScript', { 'package.json': pkg('0.1.0'), 'README.md': '# Inkwell\n\nA fast, offline-friendly notes app.\n', 'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport { App } from './App';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n" }, 0);
commit(maya, 'Add the notes store and model', { 'src/model/note.ts': note, 'src/model/store.ts': store() });
commit(daniel, 'Add a typed API client', { 'src/api/client.ts': clientV1 }, 5);
commit(sofia, 'Add the note list and editor layout', { 'src/App.tsx': "export function App() {\n  return <main className=\"layout\" />;\n}\n", 'src/styles/layout.css': '.layout {\n  display: grid;\n  grid-template-columns: 280px 1fr;\n}\n' }, 4);
commit(maya, 'Release 1.3.0', { 'package.json': pkg('1.3.0'), 'CHANGELOG.md': '## 1.3.0\n\n- Note list and editor\n' }, 6);
git(['tag', '-a', '-m', 'Release 1.3.0', 'v1.3.0']);

// Search: merged by pull request
checkout('-b', 'feature/search');
commit(daniel, 'Search notes from the sidebar', { 'src/search/useSearch.ts': searchV1 }, 20);
commit(daniel, 'Highlight matches in search results', { 'src/search/highlight.ts': "export function highlight(text: string, query: string): string[] {\n  return text.split(new RegExp(`(${escape(query)})`, 'gi'));\n}\n\nconst escape = (s: string) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');\n" });
checkout('main');
commit(sofia, 'Show relative dates in the note list', { 'src/util/formatDate.ts': formatDate(false) }, 2);
merge(maya, 'feature/search', 'Merge pull request #41 from feature/search\n\nSearch notes from the sidebar');

// Tags, then debounced search on a fix branch
checkout('-b', 'feature/tags');
commit(kenji, 'Add tag chips to the editor', { 'src/editor/TagChips.tsx': 'export function TagChips({ tags }: { tags: string[] }) {\n  return <ul className="tags">{tags.map((t) => <li key={t}>{t}</li>)}</ul>;\n}\n' }, 3);
checkout('main');
checkout('-b', 'fix/search-debounce');
commit(daniel, 'Pass an AbortSignal through the API client', { 'src/api/client.ts': clientV2 }, 2);
commit(daniel, 'Debounce search and cancel stale requests', { 'src/search/useSearch.ts': searchV2 }, 2);
checkout('feature/tags');
commit(kenji, 'Filter the note list by tag', { 'src/search/filterByTag.ts': 'import type { Note } from \'../model/note\';\n\nexport const filterByTag = (notes: Note[], tag: string) => notes.filter((n) => n.tags.includes(tag));\n' }, 1);
checkout('main');
merge(maya, 'fix/search-debounce', 'Merge pull request #44 from fix/search-debounce\n\nDebounce search and cancel stale requests', 3);
commit(sofia, 'Fix dates shown in the wrong time zone', { 'src/util/formatDate.ts': formatDate(true) }, 2);
merge(maya, 'feature/tags', 'Merge pull request #43 from feature/tags\n\nTags for notes', 2);
commit(maya, 'Release 1.4.0', { 'package.json': pkg('1.4.0'), 'CHANGELOG.md': '## 1.4.0\n\n- Search with highlighted matches\n- Tags\n\n## 1.3.0\n\n- Note list and editor\n' }, 2);
git(['tag', '-a', '-m', 'Release 1.4.0', 'v1.4.0']);

// A release branch with a hotfix
checkout('-b', 'release/1.4');
commit(sofia, 'Fix crash when a note has no tags', { 'src/editor/TagChips.tsx': 'export function TagChips({ tags = [] }: { tags?: string[] }) {\n  return <ul className="tags">{tags.map((t) => <li key={t}>{t}</li>)}</ul>;\n}\n' }, 10);

// Work in progress: offline sync (pushed) and markdown export (local only)
checkout('main');
checkout('-b', 'feature/offline-sync');
commit(daniel, 'Queue edits made while offline', { 'src/sync/queue.ts': "import type { Note } from '../model/note';\n\nexport interface PendingEdit {\n  note: Note;\n  queuedAt: number;\n}\n\nexport const pending: PendingEdit[] = [];\n" }, 3);
commit(daniel, 'Replay queued edits when the connection returns', { 'src/sync/replay.ts': "import { api } from '../api/client';\nimport { pending } from './queue';\n\nexport async function replay() {\n  while (pending.length > 0) {\n    const { note } = pending[0];\n    await api.put(`/notes/${note.id}`, note);\n    pending.shift();\n  }\n}\n" });
checkout('main');
commit(kenji, 'Keyboard shortcut to create a note', { 'src/shortcuts.ts': "export const shortcuts = {\n  newNote: 'Mod+N',\n  search: 'Mod+K',\n};\n" }, 2);
commit(sofia, 'Remember the width of the sidebar', { 'src/styles/layout.css': '.layout {\n  display: grid;\n  grid-template-columns: var(--sidebar-width, 280px) 1fr;\n}\n' });
checkout('-b', 'feature/markdown-export');
commit(maya, 'Export a note as Markdown', { 'src/export/markdown.ts': "import type { Note } from '../model/note';\n\nexport function toMarkdown(note: Note): string {\n  const tags = note.tags.map((t) => `#${t}`).join(' ');\n  return `# ${note.title}\\n\\n${note.body}\\n\\n${tags}\\n`;\n}\n" }, 2);
checkout('feature/offline-sync');
commit(daniel, 'Show an offline banner while edits are queued', { 'src/sync/OfflineBanner.tsx': 'export function OfflineBanner({ count }: { count: number }) {\n  return count > 0 ? <div className="banner">{count} change(s) will sync when you are back online</div> : null;\n}\n' }, 1);
checkout('main');
commit(kenji, 'Undo for deleted notes', { 'src/model/store.ts': store('\n  restore: (note: Note) => void;') }, 2);

// Remote: everything pushed except the local branch. The merged fix branch is deleted on the remote but kept locally (its upstream is gone)
git(['init', '-q', '--bare', remoteDir], { cwd: path.dirname(dir) });
git(['remote', 'add', 'origin', remoteUrl]);
git(['config', `url.${remoteDir}.insteadOf`, remoteUrl]);
git(['push', '-q', '-u', 'origin', 'main', 'release/1.4', 'feature/offline-sync', 'fix/search-debounce']);
git(['push', '-q', 'origin', '--tags']);
git(['push', '-q', 'origin', '--delete', 'fix/search-debounce']);
const tips = Object.fromEntries(['feature/search', 'feature/tags', 'fix/search-debounce', 'feature/offline-sync', 'release/1.4'].map((b) => [b, git(['rev-parse', b]).trim()]));
for (const b of ['feature/search', 'feature/tags']) git(['branch', '-q', '-D', b]);
commit(maya, 'Mention keyboard shortcuts in the README', { 'README.md': '# Inkwell\n\nA fast, offline-friendly notes app.\n\n## Shortcuts\n\n| Key | Action |\n| --- | --- |\n| Mod+N | New note |\n| Mod+K | Search |\n' }, 3);

// A stash
write('src/shortcuts.ts', "export const shortcuts = {\n  newNote: 'Mod+N',\n  search: 'Mod+K',\n  togglePreview: 'Mod+P',\n};\n");
git(['stash', 'push', '-q', '-m', 'Preview toggle shortcut']);

// Pull requests, as GitHub's REST API returns them (GET /repos/example/inkwell/pulls)
const iso = (rev) => git(['log', '-1', '--format=%cI', rev]).trim();
const mergeOf = (n) => git(['log', '--merges', '--format=%H', `--grep=#${n} `, 'main']).trim();
const pull = (number, title, branch, author, state) => {
  const merged = state === 'merged' ? iso(mergeOf(number)) : null;
  return {
    number,
    title,
    html_url: `https://github.com/example/inkwell/pull/${number}`,
    state: state === 'merged' ? 'closed' : 'open',
    draft: state === 'draft',
    merged_at: merged,
    updated_at: merged ?? iso(tips[branch]),
    user: { login: author },
    head: { ref: branch, sha: tips[branch], repo: { owner: { login: 'example' } } },
    base: { ref: 'main' },
  };
};
const pulls = [
  pull(47, 'Fix crash when a note has no tags', 'release/1.4', 'sofia-rossi', 'draft'),
  pull(46, 'Sync edits made while offline', 'feature/offline-sync', 'daniel-okafor', 'open'),
  pull(44, 'Debounce search and cancel stale requests', 'fix/search-debounce', 'daniel-okafor', 'merged'),
  pull(43, 'Tags for notes', 'feature/tags', 'kenji-watanabe', 'merged'),
  pull(41, 'Search notes from the sidebar', 'feature/search', 'daniel-okafor', 'merged'),
];
writeFileSync(pullsFile, JSON.stringify(pulls, null, 2) + '\n');

console.log(`created ${dir} (remote: ${remoteDir}, pull requests: ${pullsFile})`);
