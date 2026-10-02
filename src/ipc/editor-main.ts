import * as path from 'node:path';
import { ipcRequest } from './client';

// GIT_EDITOR / GIT_SEQUENCE_EDITOR helper. Sends the path of the file git passes to the Extension Host
// and waits for the host to rewrite the file. If the host returns an abort, it exits with 1 and git aborts the operation.

async function main(): Promise<number> {
  const handle = process.env.TWIGLINE_IPC_HANDLE;
  const token = process.env.TWIGLINE_IPC_TOKEN;
  const file = process.argv[2];
  if (!handle || !token || !file) return 1;
  const res = await ipcRequest(handle, { token, kind: 'editor', file: path.resolve(file) });
  return res.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
