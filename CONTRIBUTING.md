# Contributing to Twigline

Thanks for your interest! Bug reports, ideas and pull requests are welcome.
Please open an issue first for larger changes so we can agree on the direction.

## Development

```bash
npm install
npm run build            # Build the host (esbuild) and the webview (Vite)
npm run typecheck        # tsc (host, tests and webview)
npm test                 # Unit tests (Vitest, fast-check, real git)
npm run test:integration # Integration tests that launch VS Code (@vscode/test-cli)
npm run test:perf        # Timing on a repository with 100,000 commits
npm run package          # Build a VSIX
```

In VS Code, "Run Twigline" (F5) starts an Extension Development Host.

Integration tests download VS Code by default. To use an installed VS Code instead, set `TWIGLINE_VSCODE_PATH` to its executable
(the test instance runs with separate user data under `.vscode-test/`).

```bash
TWIGLINE_VSCODE_PATH="C:\Users\<you>\AppData\Local\Programs\Microsoft VS Code\Code.exe" npx vscode-test
```

### Trying the UI in a browser

The webview and the git layer can run without VS Code.
The host's `RpcRouter` runs in Node and is connected to the webview with HTTP (requests) and Server-Sent Events (responses and notifications) instead of `postMessage`.
Right-click menus are replaced by a stand-in built from `webview/context` in `package.json`.

```bash
node test/fixtures/make-demo-repo.mjs ../twigline-demo      # Create a demo repository (--commits N adds many commits)
npm run build
node dist/dev/devServer.js --repo ../twigline-demo --port 5178
# http://localhost:5178/?lang=en&theme=dark   (lang=ja and theme=light also work)
```

Syntax highlighting grammars and themes are read from the built-in extensions of an installed VS Code
(`--vscode-extensions <dir>`; by default it looks at `TWIGLINE_VSCODE_PATH` and the usual install locations, and highlighting is off if none is found).
Pull requests are read with the environment variable `GITHUB_TOKEN` (or `GH_TOKEN`) for GitHub, or `BITBUCKET_EMAIL` and `BITBUCKET_API_TOKEN` for Bitbucket (public repositories only if they are not set).

## Layout

```
shared/protocol.ts          Types shared by the host and the webview (the RPC protocol)
src/extension.ts            activate: only creates and registers the managers
src/panel/                  RepoPanelManager (one panel per repository, serializer), html (CSP and nonce), RpcRouter (validates with zod)
src/commands/               Entry points: Command Palette, context menus, keybindings
src/repo/                   RepositoryManager (discovers repositories through the vscode.git API), RepoModel, RepoWatcher
src/git/                    GitRunner, LogCursor, parsers, PatchBuilder, errors, encoding
src/services/               Snapshot, Status, Log, Diff, Stage, Ops, Rebase, Commit, PullRequest (GitHub and Bitbucket)
src/ipc/                    IpcServer (named pipe + one-time token), askpass and editor helpers
src/host/                   HostEnv (the runtime as seen from the service layer), its VS Code implementation, and the twigline-rev: scheme for opening revisions
src/syntax/                 SyntaxRegistry (resolves languages, grammars and color themes from extensions' contributes)
src/views/                  Repository list (TreeView), status bar
src/dev/devServer.ts        Development server (not included in the VSIX)
webview/src/                React app: rpc, store (Zustand), graph/layout.ts, components
webview/src/syntax/         Web Worker for syntax highlighting (Shiki, bundled separately to dist/syntax/worker.js) and its caller
test/unit/                  Parsers, graph, PatchBuilder, services, manifest
test/integration/           Integration tests in VS Code
test/perf/                  Timing
test/fixtures/              Repository generator scripts
```

The service layer never imports `vscode`; it reaches VS Code only through `HostEnv`.
That lets the same services run in unit tests and in the development server.

## Releasing

Releases are created by running the "Release" workflow (`.github/workflows/release.yml`) by hand.
Bump `version` in `package.json` and merge it to `main` first. The workflow then runs the type check and unit tests, builds the VSIX,
and creates a `v<version>` tag and a GitHub release with the VSIX attached (release notes are generated; it is a pre-release by default).
It fails without creating anything if the tag for that version already exists.
Turn on `publish` to also publish to the VS Code Marketplace and to the Open VSX Registry, which Cursor uses (see "Publishing credentials" below).
The two publishing jobs run independently after the release job, so one failing does not stop the other.

## Publishing credentials

**Open VSX** uses the repository secret `OVSX_PAT`, an access token from [open-vsx.org](https://open-vsx.org) (the namespace must match `publisher` in `package.json`).

**VS Code Marketplace** uses a Microsoft Entra ID identity instead of a personal access token, because Azure DevOps retires global personal access tokens on December 1, 2026 (see [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) in the VS Code docs).
The `publish-marketplace` job exchanges the GitHub Actions OIDC token for an Entra ID token with `azure/login`, and `vsce publish --azure-credential` publishes with it. The one-time setup:

1. Register an application in [Microsoft Entra ID](https://entra.microsoft.com) and note its application (client) ID and directory (tenant) ID. An app registration needs no Azure subscription, unlike the managed identity the VS Code docs describe for Azure Pipelines.
2. Add a federated credential to it for the "GitHub Actions deploying Azure resources" scenario with this repository's organization and name, the entity type `Environment`, and the environment name `marketplace`.
3. Add the identity as a member of the `ryota-abe` publisher with the Contributor role on the [Marketplace publisher management page](https://marketplace.visualstudio.com/manage). It is identified there by its Azure DevOps profile ID: sign in as the app with a temporary client secret and read the `id` of the response below, then delete the secret (CI uses the federated credential).
4. Create a GitHub environment named `marketplace` in this repository with the secrets `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`. Leave its deployment branch policy unrestricted, or allow the branch the release runs from.

```bash
az login --service-principal --username <client-id> --password <secret> --tenant <tenant-id> --allow-no-subscriptions
az rest --url https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
npx vsce verify-pat ryota-abe --azure-credential
```

The last command checks the publisher membership from step 3. The federated credential and the environment are only exercised by a real release.

## Localization

UI strings live in `webview/src/i18n.ts` (webview), `package.nls*.json` (manifest) and `l10n/` (host messages). English and Japanese are provided.
