import { defineConfig } from 'tsdown'

/**
 * Transpile only: no type checking, no project references, so a git install's
 * `prepare` builds without a harness checkout beside it. Every harness package
 * stays external, so the plugin shares the host's single cordis instance.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  // The harness supports Node 22.19, which has no `using`; this lowers it.
  target: 'node22.19',
  fixedExtension: false,
  dts: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
})
