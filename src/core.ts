// The heavy part that is not loaded at startup (service layer, zod, iconv-lite, jschardet).
// In the production bundle it is split out to dist/core.js and loaded when the first panel opens.
export { RepoModel } from './repo/RepoModel';
export { RpcRouter } from './panel/RpcRouter';
export { chooseEncoding, decode } from './git/encoding';
export { SyntaxRegistry } from './syntax/SyntaxRegistry';
