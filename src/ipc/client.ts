import * as net from 'node:net';
import type { IpcRequest, IpcResponse } from './IpcServer';

/** Ask the Extension Host once from a helper (askpass-main, editor-main) */
export function ipcRequest(handle: string, req: IpcRequest): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(handle);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', (d: string) => (buf += d));
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buf.trim()) as IpcResponse);
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
  });
}
