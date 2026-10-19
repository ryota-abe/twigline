// Resolves a VS Code terminal profile (terminal.integrated.profiles.*) by name, for the terminal Twigline opens.
// Extensions cannot open a terminal with a profile, so the profile is turned into a shell path and arguments here.
// Profiles with a path are supported, and "Git Bash" (source: 'Git Bash'), which is found next to the git Twigline uses.

import * as path from 'node:path';

export interface TerminalProfile {
  path?: string | string[];
  args?: string | string[];
  source?: string;
  env?: Record<string, string | null>;
}

export interface ShellLaunch {
  shellPath: string;
  shellArgs?: string | string[];
  env?: Record<string, string | null>;
}

export interface ResolveDeps {
  /** terminal.integrated.profiles.<os>; null disables a profile */
  profiles: Record<string, TerminalProfile | null | undefined>;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** The git executable Twigline uses (may be a bare name found on PATH) */
  gitPath?: string;
  exists: (p: string) => boolean;
}

/** The shell to start for a profile name, or undefined if it is unknown, disabled or not installed */
export function resolveTerminalProfile(name: string, deps: ResolveDeps): ShellLaunch | undefined {
  const profile = deps.profiles[name];
  if (profile === null) return undefined;
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  if (profile?.path) {
    const candidates = (Array.isArray(profile.path) ? profile.path : [profile.path]).map((c) => expandEnv(c, deps.env));
    // Like VS Code, the first path that exists; a bare name is left to PATH
    const shellPath = candidates.find((c) => c && (!p.isAbsolute(c) || deps.exists(c)));
    return shellPath ? { shellPath, shellArgs: profile.args, env: profile.env } : undefined;
  }
  const source = profile?.source ?? (deps.platform === 'win32' && name === 'Git Bash' ? 'Git Bash' : undefined);
  if (source === 'Git Bash' && deps.platform === 'win32') {
    const shellPath = findGitBash(deps);
    return shellPath ? { shellPath, shellArgs: profile?.args ?? ['--login', '-i'], env: profile?.env } : undefined;
  }
  return undefined;
}

/** bin\bash.exe of Git for Windows: next to the git in use (cmd\, bin\ or mingw64\bin\), then the usual install locations */
function findGitBash({ env, gitPath, exists }: ResolveDeps): string | undefined {
  const p = path.win32;
  const gitDirs: string[] = [];
  if (gitPath && p.isAbsolute(gitPath)) gitDirs.push(p.dirname(gitPath));
  else for (const dir of (env.PATH ?? env.Path ?? '').split(';')) if (dir && exists(p.join(dir, 'git.exe'))) gitDirs.push(dir);
  const candidates = [
    ...gitDirs.flatMap((d) => [p.join(d, '..', 'bin', 'bash.exe'), p.join(d, 'bash.exe'), p.join(d, '..', '..', 'bin', 'bash.exe')]),
    ...[env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs')]
      .filter((d): d is string => !!d)
      .map((d) => p.join(d, 'Git', 'bin', 'bash.exe')),
  ];
  return candidates.find(exists);
}

/** ${env:NAME} in a profile path */
function expandEnv(s: string, env: Record<string, string | undefined>): string {
  return s.replace(/\$\{env:([^}]+)\}/g, (_, k: string) => env[k] ?? '');
}
