import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

// Named pipe (Unix domain socket) that connects the askpass / editor helpers with the Extension Host.
// A one-time token is issued per operation and connections that do not match are rejected.

export type IpcRequest =
  | { token: string; kind: 'askpass'; prompt: string }
  | { token: string; kind: 'editor'; file: string };

export type IpcResponse = { ok: true; value?: string } | { ok: false; error?: string };

export interface TokenHandlers {
  askpass?: (prompt: string) => Promise<string | undefined>;
  editor?: (file: string) => Promise<boolean>;
}

export class IpcServer {
  private readonly tokens = new Map<string, TokenHandlers>();

  private constructor(
    private readonly server: net.Server,
    readonly handle: string,
    private readonly tempDir: string | undefined,
  ) {}

  static async create(): Promise<IpcServer> {
    let handle: string;
    let tempDir: string | undefined;
    if (process.platform === 'win32') {
      handle = `\\\\.\\pipe\\twigline-${randomBytes(12).toString('hex')}`;
    } else {
      // mkdtemp creates a 0700 directory
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'twigline-'));
      handle = path.join(tempDir, 'ipc.sock');
    }
    const server = net.createServer();
    const ipc = new IpcServer(server, handle, tempDir);
    server.on('connection', (socket) => ipc.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(handle, () => {
        server.off('error', reject);
        resolve();
      });
    });
    return ipc;
  }

  /** Issue a token for one git operation */
  register(handlers: TokenHandlers): { token: string; dispose(): void } {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, handlers);
    return { token, dispose: () => this.tokens.delete(token) };
  }

  private onConnection(socket: net.Socket): void {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (d: string) => {
      buf += d;
      if (buf.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = '';
      void this.handle1(line).then(
        (res) => socket.end(JSON.stringify(res) + '\n'),
        () => socket.end(JSON.stringify({ ok: false } satisfies IpcResponse) + '\n'),
      );
    });
  }

  private async handle1(line: string): Promise<IpcResponse> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      return { ok: false, error: 'bad request' };
    }
    const handlers = typeof req?.token === 'string' ? this.tokens.get(req.token) : undefined;
    if (!handlers) return { ok: false, error: 'invalid token' };
    if (req.kind === 'askpass' && handlers.askpass && typeof req.prompt === 'string') {
      const value = await handlers.askpass(req.prompt);
      return value === undefined ? { ok: false } : { ok: true, value };
    }
    if (req.kind === 'editor' && handlers.editor && typeof req.file === 'string') {
      const ok = await handlers.editor(req.file);
      return ok ? { ok: true } : { ok: false };
    }
    return { ok: false, error: 'unsupported' };
  }

  dispose(): void {
    this.tokens.clear();
    this.server.close();
    if (this.tempDir) void rm(this.tempDir, { recursive: true, force: true });
  }
}

/** Wrap in single quotes for the shell (the sh in which git runs GIT_EDITOR) */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Turn a Windows path into a form Git for Windows' sh can handle (use / as separator) */
export function toShellPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}
