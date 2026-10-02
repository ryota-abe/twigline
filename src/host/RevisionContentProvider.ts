import * as vscode from 'vscode';
import { loadCore } from '../coreLoader';
import type { RepositoryManager } from '../repo/RepositoryManager';
import type { HostEnv } from './HostEnv';

export const REV_SCHEME = 'twigline-rev';

/**
 * Opens the content of a file at a given revision as a read-only document (used for both sides of the diff editor).
 * URI: twigline-rev:/<relative path>?<{"root","rev"}>. When rev is ":", it is the index.
 */
export function revUri(root: string, rev: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: REV_SCHEME,
    path: '/' + relPath,
    query: JSON.stringify({ root, rev }),
  });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly repos: RepositoryManager,
    private readonly env: HostEnv,
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: { root?: string; rev?: string };
    try {
      q = JSON.parse(uri.query);
    } catch {
      return '';
    }
    if (!q.root || typeof q.rev !== 'string') return '';
    const rel = uri.path.replace(/^\//, '');
    const model = await this.repos.model(q.root);
    const spec = q.rev === ':' ? `:${rel}` : `${q.rev}:${rel}`;
    if (q.rev !== ':' && !/^[0-9a-f]{4,64}$|^HEAD$/i.test(q.rev)) return '';
    const res = await model.runner.run(['cat-file', 'blob', spec], { noThrow: true, maxStdoutBytes: 50 * 1024 * 1024 });
    if (res.exitCode !== 0) return '';
    const { chooseEncoding, decode } = loadCore();
    const enc = chooseEncoding(res.stdout.subarray(0, 64 * 1024), this.env.encodingFor(model.resolvePath(rel)));
    let text = decode(res.stdout, enc);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }
}
