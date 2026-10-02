// Creates a repository for manual testing (repository generator script)
//   node test/fixtures/make-demo-repo.mjs <dir> [--commits N]
// Contains branches, merges, tags, a remote, stashes, Japanese file names, Shift_JIS, CRLF and uncommitted changes.
// --commits adds a large linear history (for timing with 100,000 commits).

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'demo-repo');
const i = process.argv.indexOf('--commits');
const extra = i >= 0 ? Number(process.argv[i + 1]) : 0;

if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const remoteDir = dir + '-origin.git';
if (existsSync(remoteDir)) rmSync(remoteDir, { recursive: true, force: true });

let clock = 1_758_000_000;
const people = [
  ['佐藤 花子', 'sato@example.com'],
  ['鈴木 一郎', 'suzuki@example.com'],
  ['高橋 誠', 'takahashi@example.com'],
];
let who = 0;

function git(args, opts = {}) {
  const [name, email] = people[who % people.length];
  const date = `${clock} +0900`;
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd: opts.cwd ?? dir,
    input: opts.input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}
function write(rel, content) {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
function commit(msg, files, author) {
  if (author !== undefined) who = author;
  for (const [k, v] of Object.entries(files ?? {})) write(k, v);
  git(['add', '-A']);
  clock += 3600 + Math.floor(Math.random() * 7200);
  git(['commit', '-q', '--allow-empty', '-m', msg]);
}

git(['init', '-q']);
git(['config', 'user.name', '佐藤 花子']);
git(['config', 'user.email', 'sato@example.com']);
git(['config', 'core.autocrlf', 'false']);

const lines = (n, prefix) => Array.from({ length: n }, (_, k) => `${prefix} ${k + 1}`).join('\n') + '\n';

commit('プロジェクトを作成', { 'README.md': '# twigline-app\n\nデモ用のリポジトリです。\n', 'src/index.ts': 'export const version = 1;\n' }, 0);
commit('CI の Node バージョンを更新', { '.github/workflows/ci.yml': 'node-version: 20\n' }, 2);
commit('リリース 1.2 の準備', { 'CHANGELOG.md': '## 1.2.0\n' }, 0);
git(['tag', '-a', '-m', 'Release 1.1.0', 'v1.1.0']);

git(['checkout', '-q', '-b', 'feature/login']);
commit('認証 API クライアントを追加', { 'src/auth/client.ts': lines(30, '// client line') }, 1);
commit('ログイン画面の入力チェックを追加', {
  'src/auth/validate.ts': [
    'export function validate(form: LoginForm) {',
    '  const errors: string[] = [];',
    "  if (!isEmail(form.email)) errors.push('email');",
    '  if (form.password.length < 12) {',
    "    errors.push('password');",
    '  }',
    '  return errors;',
    '}',
    '',
  ].join('\n'),
  'src/auth/rules.ts': lines(48, '// rule'),
}, 1);

git(['checkout', '-q', 'main']);
commit('差分ビューの行番号のずれを修正', { 'src/diff/view.ts': lines(40, 'view') }, 2);
git(['tag', 'v1.2.0']);
who = 0;
clock += 3600;
git(['merge', '-q', '--no-ff', '-m', "Merge branch 'feature/login'", 'feature/login']);
commit('ツールバーに ahead/behind バッジを表示', { 'src/toolbar.ts': lines(12, 'toolbar') }, 0);

git(['checkout', '-q', '-b', 'feature/graph-view']);
commit('グラフのレーン計算を追加', { 'src/graph/layout.ts': lines(60, 'layout') }, 1);
commit('グラフの色をテーマに合わせる', { 'src/graph/colors.ts': lines(8, 'color') }, 2);
git(['checkout', '-q', 'main']);
git(['checkout', '-q', '-b', 'release/1.2']);
commit('バージョンを 1.2.1 に更新', { 'CHANGELOG.md': '## 1.2.1\n\n## 1.2.0\n' }, 0);
git(['checkout', '-q', 'main']);

// Shift_JIS and CRLF files
commit('Shift_JIS の設定ファイルを追加', {
  'legacy/設定.ini': Buffer.from('[\x90\xdd\x92\xe8]\r\nname=\x83\x65\x83\x58\x83\x67\r\n', 'latin1'),
  'docs/日本語のメモ.md': '# メモ\n\n- 一つ目\n- 二つ目\n',
}, 2);

for (let k = 0; k < extra; k++) {
  commit(`自動生成のコミット ${k + 1}`, { 'generated/log.txt': `${k}\n` }, k);
}

// Remote (a local bare repository)
git(['init', '-q', '--bare', remoteDir], { cwd: path.dirname(dir) });
git(['remote', 'add', 'origin', remoteDir]);
git(['push', '-q', '-u', 'origin', 'main', 'feature/login', 'release/1.2']);
git(['push', '-q', 'origin', '--tags']);
// Go one ahead of origin (ahead 1)
commit('README に使い方を追記', { 'README.md': '# twigline-app\n\nデモ用のリポジトリです。\n\n## 使い方\n\n`npm start`\n' }, 0);

// Stash
write('src/index.ts', 'export const version = 2; // WIP\n');
git(['stash', 'push', '-q', '-m', 'バージョン番号の実験']);

// Uncommitted changes (staged, unstaged, untracked)
write('src/toolbar.ts', lines(12, 'toolbar').replace('toolbar 3', 'toolbar 3（変更）') + 'toolbar 13\n');
git(['add', 'src/toolbar.ts']);
write('src/diff/view.ts', lines(40, 'view').replace('view 5\n', 'view 5 changed\nview 5.5 added\n').replace('view 30\n', ''));
write('docs/design.md', '# 設計メモ\n\n未追跡のファイルです。\n');
write('src/auth/validate.ts', "export function validate(form: LoginForm) {\n  const errors: string[] = [];\n  if (!isEmail(form.email)) errors.push('email');\n  if (form.password.length < 12) {\n    errors.push('password');\n  }\n  return errors;\n}\n\nexport const MIN_LENGTH = 12;\n");

console.log(`created ${dir} (remote: ${remoteDir})`);
