// Build script that runs both the host (esbuild) and the webview (Vite) builds.
//   node scripts/build.mjs               build everything
//   node scripts/build.mjs --host        host only
//   node scripts/build.mjs --watch       watch-build the host (the webview uses vite build --watch)
//   node scripts/build.mjs --production  minified, no source maps
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const hostOnly = args.has('--host');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  absWorkingDir: root,
  // The default entry of jsonc-parser (UMD) builds require dynamically and cannot be bundled. Use the ESM build.
  alias: { 'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js' },
};

/**
 * extension.js does not include the heavy part (src/core.ts); it loads dist/core.js at run time to keep activation fast.
 * @type {import('esbuild').Plugin}
 */
const coreExternal = {
  name: 'core-external',
  setup(b) {
    b.onResolve({ filter: /^\.\/core$/ }, (args) =>
      args.importer.replace(/\\/g, '/').endsWith('src/coreLoader.ts') ? { path: './core.js', external: true } : undefined,
    );
  },
};

const hostBuilds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', external: ['vscode'], plugins: [coreExternal] },
  { ...common, entryPoints: ['src/core.ts'], outfile: 'dist/core.js', external: ['vscode'] },
  { ...common, entryPoints: ['src/ipc/askpass-main.ts'], outfile: 'dist/askpass-main.js' },
  { ...common, entryPoints: ['src/ipc/editor-main.ts'], outfile: 'dist/editor-main.js' },
];
// Web Worker for syntax highlighting (Shiki). Not part of the webview bundle; loaded when the first diff is colored.
// Vite empties its output folder (dist/webview) on every build, so emit this to a separate folder.
hostBuilds.push({
  ...common,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  entryPoints: ['webview/src/syntax/worker.ts'],
  outfile: 'dist/syntax/worker.js',
});
if (!production) {
  hostBuilds.push({ ...common, entryPoints: ['src/dev/devServer.ts'], outfile: 'dist/dev/devServer.js' });
}

async function copyShellHelpers() {
  await mkdir(path.join(root, 'dist'), { recursive: true });
  const dest = path.join(root, 'dist/askpass.sh');
  await copyFile(path.join(root, 'src/ipc/askpass.sh'), dest);
  if (process.platform !== 'win32') await chmod(dest, 0o755);
}

function runVite(extra = []) {
  return new Promise((resolve, reject) => {
    const bin = path.join(root, 'node_modules/vite/bin/vite.js');
    const p = spawn(process.execPath, [bin, 'build', '--config', 'webview/vite.config.mts', '--logLevel', 'warn', ...extra], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: production ? 'production' : 'development' },
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited with ${code}`))));
  });
}

await copyShellHelpers();
if (watch) {
  for (const b of hostBuilds) (await context(b)).watch();
  runVite(['--watch']).catch((e) => console.error(e));
} else {
  await Promise.all(hostBuilds.map((b) => build(b)));
  if (!hostOnly) await runVite();
}
