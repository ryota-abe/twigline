import { writeFileSync } from 'node:fs';
import { ipcRequest } from './client';

// GIT_ASKPASS / SSH_ASKPASS helper. Sends the prompt git passes to the Extension Host,
// writes the user's input to a temporary file (or stdout if there is none), and exits.

async function main(): Promise<number> {
  const handle = process.env.TWIGLINE_IPC_HANDLE;
  const token = process.env.TWIGLINE_IPC_TOKEN;
  const prompt = process.argv.slice(2).join(' ');
  if (!handle || !token) return 1;
  const res = await ipcRequest(handle, { token, kind: 'askpass', prompt });
  if (!res.ok || res.value === undefined) return 1;
  const out = process.env.TWIGLINE_ASKPASS_OUT;
  if (out) writeFileSync(out, res.value + '\n', { encoding: 'utf8', mode: 0o600 });
  else process.stdout.write(res.value + '\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(1),
);
