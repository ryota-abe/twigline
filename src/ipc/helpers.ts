import * as path from 'node:path';
import { IpcServer, shellQuote, toShellPath, type TokenHandlers } from './IpcServer';

export interface HelperEnv {
  env: Record<string, string>;
  dispose(): void;
}

/** Build the environment variables for the askpass / editor helpers. The IPC server is started the first time it is needed. */
export class GitHelpers {
  private server?: Promise<IpcServer>;

  constructor(
    private readonly extensionPath: string,
    private readonly execPath: string,
  ) {}

  private ipc(): Promise<IpcServer> {
    this.server ??= IpcServer.create();
    return this.server;
  }

  /** Environment variables for operations that need authentication (fetch, pull, push) */
  async authEnv(askpass: (prompt: string) => Promise<string | undefined>): Promise<HelperEnv> {
    const ipc = await this.ipc();
    const reg = ipc.register({ askpass });
    const script = path.join(this.extensionPath, 'dist', 'askpass.sh');
    return {
      env: {
        TWIGLINE_IPC_HANDLE: ipc.handle,
        TWIGLINE_IPC_TOKEN: reg.token,
        TWIGLINE_HELPER_NODE: this.execPath,
        TWIGLINE_ASKPASS_MAIN: path.join(this.extensionPath, 'dist', 'askpass-main.js'),
        GIT_ASKPASS: script,
        SSH_ASKPASS: script,
        SSH_ASKPASS_REQUIRE: 'force',
      },
      dispose: () => reg.dispose(),
    };
  }

  /** Environment variables that set the helper as GIT_EDITOR / GIT_SEQUENCE_EDITOR (for interactive rebase) */
  async editorEnv(handlers: TokenHandlers, opts: { sequence: boolean }): Promise<HelperEnv> {
    const ipc = await this.ipc();
    const reg = ipc.register(handlers);
    // git runs this string through a shell. Protect an install path containing spaces with single quotes
    const command = `${shellQuote(toShellPath(this.execPath))} ${shellQuote(toShellPath(path.join(this.extensionPath, 'dist', 'editor-main.js')))}`;
    const env: Record<string, string> = {
      ELECTRON_RUN_AS_NODE: '1',
      TWIGLINE_IPC_HANDLE: ipc.handle,
      TWIGLINE_IPC_TOKEN: reg.token,
      GIT_EDITOR: command,
    };
    if (opts.sequence) env.GIT_SEQUENCE_EDITOR = command;
    return { env, dispose: () => reg.dispose() };
  }

  dispose(): void {
    void this.server?.then((s) => s.dispose());
  }
}
