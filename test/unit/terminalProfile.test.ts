import { describe, expect, it } from 'vitest';
import { resolveTerminalProfile, type ResolveDeps } from '../../src/util/terminalProfile';

const win = (files: string[], over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  profiles: { 'Git Bash': { source: 'Git Bash' }, PowerShell: { source: 'PowerShell' } },
  platform: 'win32',
  env: { ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', windir: 'C:\\Windows' },
  exists: (p) => files.includes(p),
  ...over,
});

describe('resolveTerminalProfile', () => {
  it('finds Git Bash next to the git in use (cmd, bin or mingw64\\bin)', () => {
    const bash = 'D:\\Tools\\Git\\bin\\bash.exe';
    for (const gitPath of ['D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\git.exe', 'D:\\Tools\\Git\\mingw64\\bin\\git.exe']) {
      expect(resolveTerminalProfile('Git Bash', win([bash], { gitPath }))).toEqual({ shellPath: bash, shellArgs: ['--login', '-i'], env: undefined });
    }
  });

  it('finds Git Bash through git on PATH, then in the usual install locations', () => {
    const bash = 'E:\\Git\\bin\\bash.exe';
    expect(resolveTerminalProfile('Git Bash', win([bash, 'E:\\Git\\cmd\\git.exe'], { gitPath: 'git', env: { PATH: 'C:\\Windows;E:\\Git\\cmd' } }))?.shellPath).toBe(bash);
    expect(resolveTerminalProfile('Git Bash', win(['C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe']))?.shellPath).toBe(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    );
    expect(resolveTerminalProfile('Git Bash', win([]))).toBeUndefined();
  });

  it('uses the first existing path of a profile, expanding ${env:...}, with its args', () => {
    const deps = win(['C:\\Windows\\System32\\cmd.exe'], {
      profiles: { cmd: { path: ['C:\\missing\\cmd.exe', '${env:windir}\\System32\\cmd.exe'], args: ['/k', 'chcp 65001'] } },
    });
    expect(resolveTerminalProfile('cmd', deps)).toEqual({ shellPath: 'C:\\Windows\\System32\\cmd.exe', shellArgs: ['/k', 'chcp 65001'], env: undefined });
    expect(resolveTerminalProfile('zsh', { profiles: { zsh: { path: 'zsh', args: ['-l'] } }, platform: 'darwin', env: {}, exists: () => false })).toEqual({
      shellPath: 'zsh',
      shellArgs: ['-l'],
      env: undefined,
    });
  });

  it('gives nothing for unknown, disabled or unsupported profiles', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(resolveTerminalProfile('fish', win([bash]))).toBeUndefined();
    expect(resolveTerminalProfile('Git Bash', win([bash], { profiles: { 'Git Bash': null } }))).toBeUndefined();
    expect(resolveTerminalProfile('PowerShell', win([bash]))).toBeUndefined();
    expect(resolveTerminalProfile('Git Bash', { profiles: {}, platform: 'linux', env: {}, exists: () => true })).toBeUndefined();
  });
});
