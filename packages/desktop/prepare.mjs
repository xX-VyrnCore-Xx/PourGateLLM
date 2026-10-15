// Copies the built server, dashboard, registry and evals into src-tauri/server
// so Tauri can bundle them as resources. Run `pnpm build` at the repo root first.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
console.log(`Prepared ${out}`);
