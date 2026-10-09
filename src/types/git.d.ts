// Only the part of the API of the vscode.git extension (getAPI(1)) that Twigline uses.
// Used only for discovery, the path of the git executable, state change events and the counts in the repository list.
import type { Event, Uri } from 'vscode';

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
}

export interface UpstreamRef {
  readonly remote: string;
  readonly name: string;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: UpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface Submodule {
  readonly name: string;
  readonly path: string;
  readonly url: string;
}

export interface Change {
  readonly uri: Uri;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly submodules: Submodule[];
  /** Conflicted files */
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  /** Filled only when git.untrackedChanges is "separate" (with "mixed" they are in workingTreeChanges) */
  readonly untrackedChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
}
