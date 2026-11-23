import { defineConfig } from '@playwright/test';

const base = process.env.ORIGAMI_BASE_PATH;
const url = `http://127.0.0.1:4175${base?.startsWith('/') ? base : '/'}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '*.browser.mjs',
  use: {
    baseURL: url,
    launchOptions: { executablePath: process.env.ORIGAMI_CHROMIUM_PATH },
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4175 --strictPort',
    url,
  },
});
