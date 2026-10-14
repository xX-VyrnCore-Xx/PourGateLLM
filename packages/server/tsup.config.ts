import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  // Bundle everything so the runtime image needs no node_modules.
  noExternal: [/.*/],
  // Some bundled deps use CommonJS require(); give the ESM output a real one.
  banner: { js: "import { createRequire as __pgCreateRequire } from 'node:module'; const require = __pgCreateRequire(import.meta.url);" },
});
