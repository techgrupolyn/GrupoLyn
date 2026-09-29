import { cpSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'tsup';

const outputDir = process.env.LYN_EVOLUTION_BUILD_DIR || 'dist';

export default defineConfig({
  entry: ['src/main.ts'],
  outDir: outputDir,
  splitting: false,
  sourcemap: false,
  clean: true,
  minify: true,
  format: ['cjs'],
  onSuccess: async () => {
    cpSync('src/utils/translations', join(outputDir, 'translations'), { recursive: true });
  },
  loader: {
    '.json': 'file',
    '.yml': 'file',
  },
});
