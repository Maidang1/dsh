import { defineConfig } from '@playwright/test'

const port = 4397
export const LAUNCH_TOKEN = 'e2e-launch-token'
export const STORAGE_STATE = 'test-results/.auth.json'

/** Browser end-to-end tests against the built UI served by the real local server. */
export default defineConfig({
  testDir: 'apps/explorer/e2e',
  globalSetup: './apps/explorer/e2e/global-setup.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    actionTimeout: 10_000,
    storageState: STORAGE_STATE,
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
  },
  webServer: {
    command: `rm -rf .explorer-e2e && EXPLORER_STORE=.explorer-e2e EXPLORER_PORT=${port} EXPLORER_TOKEN=${LAUNCH_TOKEN} pnpm -s explorer`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
