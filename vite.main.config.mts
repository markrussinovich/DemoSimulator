import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist/main',
    emptyOutDir: true,
    minify: true,
    rollupOptions: {
      input: { main: path.resolve('src/main/main.ts'), preload: path.resolve('src/preload/preload.ts') },
      external: ['electron', /^node:/],
      output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' }
    }
  }
});
