// Copies the built server, dashboard, registry and evals into src-tauri/server
// so Tauri can bundle them as resources. Run `pnpm build` at the repo root first.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = resolve(root, 'packages/desktop/src-tauri/server');
const parts = [
  ['packages/server/dist', 'dist'],
  ['packages/client/dist', 'public'],
  ['registry', 'registry'],
  ['evals', 'evals'],
];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of parts) {
  const src = resolve(root, from);
  if (!existsSync(src)) throw new Error(`${from} is missing: run "pnpm build" first`);
  cpSync(src, resolve(out, to), { recursive: true });
}
// --bundle-node: ship the Node.js runtime that is running this script, so the app needs nothing installed.
if (process.argv.includes('--bundle-node')) {
  const target = resolve(out, process.platform === 'win32' ? 'node.exe' : 'node');
  copyFileSync(process.execPath, target);
  if (process.platform !== 'win32') chmodSync(target, 0o755);
  console.log(`Bundled Node ${process.version}`);
}
console.log(`Prepared ${out}`);
