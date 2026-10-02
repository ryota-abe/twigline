// Configuration for @vscode/test-cli (integration tests)
// Before running, bundles the tests with esbuild, creates a fixture repository and opens it as the workspace.
import { defineConfig } from '@vscode/test-cli';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const fixture = path.join(os.tmpdir(), 'twigline-integration', 'twigline-app');
mkdirSync(path.dirname(fixture), { recursive: true });
execFileSync(process.execPath, [path.join(root, 'test/fixtures/make-demo-repo.mjs'), fixture], { stdio: 'inherit' });

await build({
  entryPoints: [path.join(root, 'test/integration/extension.test.ts')],
  outfile: path.join(root, 'out/test/integration/extension.test.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'warning',
});

// If TWIGLINE_VSCODE_PATH points to an installed VS Code (Code.exe etc.), it is used instead of downloading one.
// The test instance runs with separate user data under .vscode-test/.
const installed = process.env.TWIGLINE_VSCODE_PATH;

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  ...(installed ? { useInstallation: { fromPath: installed } } : { version: process.env.TWIGLINE_VSCODE_VERSION ?? 'stable' }),
  workspaceFolder: fixture,
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  mocha: { ui: 'bdd', timeout: 60_000 },
});
