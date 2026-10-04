import { z } from 'zod';

// Every request from the webview is validated before being passed to a service.
// A SHA matches ^[0-9a-f]{4,64}$, a ref name does not start with - or contain control characters, a path does not contain NUL.
// Whether a path is under the repository root is checked by RepoModel.resolvePath.

const sha = z.string().regex(/^[0-9a-f]{4,64}$/i, 'invalid sha');
const ref = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !s.startsWith('-') && !/[\0\r\n]/.test(s), 'invalid ref');
const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => !s.includes('\0'), 'invalid path');
const remote = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.startsWith('-') && !/[\s\0]/.test(s), 'invalid remote');
const repo = z.string().min(1);
const text = z.string().max(1024 * 1024);

export const diffTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worktree') }),
  z.object({ kind: z.literal('index') }),
  z.object({ kind: z.literal('commit'), sha, parent: z.number().int().min(0).max(64).optional() }),
  z.object({ kind: z.literal('range'), from: sha, to: sha }),
]);

export const logQuery = z.object({
  branches: z.union([z.literal('all'), z.literal('current'), z.object({ refs: z.array(ref).max(256) })]),
  includeRemotes: z.boolean(),
  includeStashes: z.boolean(),
  order: z.enum(['date', 'topo']),
  path: filePath.optional(),
  follow: z.boolean().optional(),
  search: z.object({ mode: z.enum(['message', 'author', 'content', 'sha']), text: z.string().max(1000) }).optional(),
});

const todoItem = z.object({
  action: z.enum(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']),
  sha,
  subject: z.string().max(10_000),
  message: text.optional(),
});

export const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('checkout'), ref, createTracking: ref.optional(), detach: z.boolean().optional() }),
  z.object({ kind: z.literal('branch/create'), name: ref, start: ref, checkout: z.boolean() }),
  z.object({
    kind: z.literal('branch/delete'),
    names: z.array(ref).max(1000),
    force: z.boolean(),
    remoteBranches: z.array(z.object({ remote, branch: ref })).max(1000).optional(),
  }),
  z.object({ kind: z.literal('branch/rename'), from: ref, to: ref }),
  z.object({ kind: z.literal('branch/setUpstream'), branch: ref, upstream: ref.nullable() }),
  z.object({ kind: z.literal('remoteBranch/delete'), remote, branch: ref }),
  z.object({ kind: z.literal('merge'), ref, noFastForward: z.boolean(), squash: z.boolean(), commit: z.boolean(), autostash: z.boolean().optional() }),
  z.object({ kind: z.literal('rebase'), onto: ref, autostash: z.boolean(), updateRefs: z.boolean() }),
  z.object({ kind: z.literal('cherry-pick'), shas: z.array(sha).min(1).max(1000), noCommit: z.boolean() }),
  z.object({ kind: z.literal('revert'), sha }),
  z.object({ kind: z.literal('reset'), sha, mode: z.enum(['soft', 'mixed', 'hard']) }),
  z.object({ kind: z.literal('fetch'), remote: z.union([z.literal('*'), remote]), prune: z.boolean(), tags: z.boolean() }),
  z.object({ kind: z.literal('pull'), remote, branch: ref, rebase: z.boolean(), ffOnly: z.boolean(), into: ref.optional(), autostash: z.boolean().optional() }),
  z.object({
    kind: z.literal('push'),
    remote,
    branches: z.array(z.object({ local: ref, remote: ref, setUpstream: z.boolean() })).max(1000),
    tags: z.boolean(),
    force: z.boolean(),
  }),
  z.object({
    kind: z.literal('stash/push'),
    message: z.string().max(10_000).optional(),
    keepIndex: z.boolean(),
    includeUntracked: z.boolean(),
    stagedOnly: z.boolean(),
  }),
  z.object({ kind: z.literal('stash/apply'), index: z.number().int().min(0), drop: z.boolean(), restoreIndex: z.boolean() }),
  z.object({ kind: z.literal('stash/drop'), index: z.number().int().min(0) }),
  z.object({ kind: z.literal('stash/branch'), index: z.number().int().min(0), name: ref }),
  z.object({ kind: z.literal('tag/create'), name: ref, sha, message: text.optional(), pushTo: remote.optional() }),
  z.object({ kind: z.literal('tag/delete'), name: ref, remote: remote.optional() }),
  z.object({ kind: z.literal('tag/push'), name: ref, remote }),
  z.object({ kind: z.literal('discard'), paths: z.array(filePath).max(100_000), untracked: z.array(filePath).max(100_000) }),
  z.object({ kind: z.literal('conflict/resolve'), paths: z.array(filePath).min(1), side: z.enum(['current', 'incoming']) }),
  z.object({ kind: z.literal('conflict/mark'), paths: z.array(filePath).min(1), resolved: z.boolean() }),
  z.object({ kind: z.literal('file/restore'), sha, path: filePath }),
  z.object({ kind: z.literal('gitignore/add'), pattern: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('remote/add'), name: remote, url: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('remote/edit'), name: remote, newName: remote, url: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('remote/remove'), name: remote }),
  z.object({ kind: z.literal('config/user'), name: z.string().max(1024), email: z.string().max(1024) }),
  z.object({ kind: z.literal('rebase/interactive'), base: sha.nullable(), todo: z.array(todoItem).min(1).max(10_000) }),
  z.object({ kind: z.literal('sequence/control'), action: z.enum(['continue', 'skip', 'abort']), message: text.optional() }),
]);

export const uiAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('openDiff'), target: diffTarget, path: filePath, oldPath: filePath.optional() }),
  z.object({ kind: z.literal('openFile'), path: filePath, sha: sha.optional() }),
  z.object({ kind: z.literal('compareWithWorktree'), sha, path: filePath }),
  z.object({ kind: z.literal('revealInOS'), path: filePath }),
  z.object({ kind: z.literal('copy'), text: text }),
  z.object({ kind: z.literal('showOutput') }),
  z.object({ kind: z.literal('openMergeEditor'), path: filePath }),
  z.object({ kind: z.literal('openGitignore') }),
  z.object({ kind: z.literal('createPatch'), shas: z.array(sha).min(1).max(1000) }),
  z.object({ kind: z.literal('createPullRequest'), branch: ref }),
  z.object({ kind: z.literal('openPullRequest'), ref }),
  z.object({ kind: z.literal('pullRequestSignIn'), provider: z.enum(['github', 'bitbucket']) }),
  z.object({ kind: z.literal('customAction'), sha: sha.optional(), path: filePath.optional(), ref: ref.optional() }),
  z.object({ kind: z.literal('openSettings') }),
  z.object({ kind: z.literal('openRepo'), path: filePath }),
  z.object({ kind: z.literal('removeLock') }),
  z.object({ kind: z.literal('optimize') }),
  z.object({ kind: z.literal('saveUiState'), state: z.record(z.string(), z.unknown()) }),
]);

export const methodParams = {
  'app/init': z.object({ repo }),
  'repo/snapshot': z.object({ repo }),
  'repo/resolve': z.object({ repo, rev: ref }),
  'ref/validate': z.object({ repo, name: z.string().max(1024) }),
  'ref/compare': z.object({ repo, ours: ref, theirs: ref, files: z.boolean().optional(), conflicts: z.boolean().optional() }),
  'ref/aheadBehind': z.object({ repo, base: ref, refs: z.array(ref.refine((s) => s.startsWith('refs/'), 'not a full ref name')).max(10_000) }),
  'log/page': z.object({
    repo,
    query: logQuery,
    cursor: z.string().max(64).optional(),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(100_000),
  }),
  'commit/detail': z.object({ repo, sha, compareTo: sha.optional(), parent: z.number().int().min(0).max(64).optional() }),
  'commit/info': z.object({ repo }),
  'diff/file': z.object({
    repo,
    target: diffTarget,
    path: filePath,
    oldPath: filePath.optional(),
    context: z.number().int().min(0).max(25),
    ignoreWhitespace: z.boolean(),
    untracked: z.boolean().optional(),
    full: z.boolean().optional(),
  }),
  'status/get': z.object({ repo }),
  'stage/paths': z.object({ repo, paths: z.array(filePath).max(100_000), action: z.enum(['stage', 'unstage']) }),
  'stage/lines': z.object({
    repo,
    diffId: z.string().max(64),
    lineIds: z.array(z.number().int().min(0)).min(1).max(1_000_000),
    action: z.enum(['stage', 'unstage', 'discard']),
  }),
  'commit/create': z.object({
    repo,
    message: z.string().min(1).max(1024 * 1024),
    amend: z.boolean(),
    signoff: z.boolean(),
    noVerify: z.boolean(),
    pushAfter: z.boolean(),
  }),
  'op/run': z.object({ repo, op: operation, dryRun: z.boolean().optional() }),
  'rebase/commits': z.object({ repo, base: sha.nullable() }),
  'pr/list': z.object({ repo, force: z.boolean().optional() }),
  'ui/action': z.object({ repo, action: uiAction }),
  'ui/editMessageReply': z.object({ requestId: z.string().max(64), message: text.nullable() }),
  'syntax/language': z.object({ path: filePath, loaded: z.array(z.string().max(256)).max(1000) }),
  'syntax/theme': z.object({}),
} as const;
