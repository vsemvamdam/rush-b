import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the built site (npm run build) served by vite preview.
// Data generated in CI (teams, logos, profiles) can be rebuilt locally: see replica/test-plan.md.
export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173/rush-b/',
    colorScheme: 'dark',
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/rush-b/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
