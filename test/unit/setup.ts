import { mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Use an empty config file so the user's global settings (signing, autocrlf, hooks, etc.) do not affect the tests
const dir = mkdtempSync(path.join(os.tmpdir(), 'twigline-gitconfig-'));
const globalConfig = path.join(dir, 'gitconfig');
writeFileSync(globalConfig, '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test User';
process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
process.env.GIT_COMMITTER_NAME = 'Test User';
process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
