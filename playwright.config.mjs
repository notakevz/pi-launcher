import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui',
  outputDir: './.build/playwright',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    channel: 'msedge',
    headless: true,
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 500, height: 900 },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'light', use: { colorScheme: 'light', deviceScaleFactor: 1 } },
    { name: 'dark-dpi125', use: { colorScheme: 'dark', deviceScaleFactor: 1.25 } },
    { name: 'large-font-dpi150', use: { colorScheme: 'light', deviceScaleFactor: 1.5 } },
  ],
  webServer: { command: 'npm run preview:ui', url: 'http://127.0.0.1:4173/tray.html', reuseExistingServer: false },
});
