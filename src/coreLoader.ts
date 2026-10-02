import type * as Core from './core';

let core: typeof Core | undefined;

/**
 * Loads the heavy part when it is needed. esbuild treats './core' as the external dist/core.js
 * (the coreExternal plugin in scripts/build.mjs).
 */
export function loadCore(): typeof Core {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  core ??= require('./core') as typeof Core;
  return core;
}
