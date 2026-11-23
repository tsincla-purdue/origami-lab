import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const sharedNotices = {
  LICENSE: readFileSync(new URL('./LICENSE', import.meta.url), 'utf8'),
  'Origamio-LICENSE.txt': readFileSync(new URL('./vendor/origamio/LICENSE', import.meta.url), 'utf8'),
};
const browserNotices = {
  ...sharedNotices,
  'THIRD-PARTY-NOTICES.txt': readFileSync(new URL('./THIRD-PARTY-NOTICES.txt', import.meta.url), 'utf8'),
};

export default defineConfig(({ isSsrBuild }) => {
  const notices = Object.entries(isSsrBuild ? sharedNotices : browserNotices);
  const banner = notices.map(([fileName, source]) => `${fileName}\n${source.trimEnd()}`).join('\n\n');

  return {
    base: process.env.ORIGAMI_BASE_PATH ?? './',
    plugins: [{
      name: 'distribution-licenses',
      apply: 'build',
      generateBundle() {
        for (const [fileName, source] of notices) {
          this.emitFile({ type: 'asset', fileName, source });
        }
      },
    }],
    build: {
      rolldownOptions: {
        output: { comments: { legal: true }, banner: `/*!\n${banner}\n*/` },
      },
    },
  };
});
