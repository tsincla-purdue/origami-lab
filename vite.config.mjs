import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const license = readFileSync(new URL('./vendor/origamio/LICENSE', import.meta.url), 'utf8');

export default defineConfig({
  base: './',
  plugins: [{
    name: 'origamio-license',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'Origamio-LICENSE.txt', source: license });
    },
  }],
  build: {
    rolldownOptions: {
      output: { comments: { legal: true }, banner: `/*! Origamio upstream license\n${license.trimEnd()}\n*/` },
    },
  },
});
