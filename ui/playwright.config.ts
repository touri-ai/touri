import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 20_000,
  use: {
    headless: true,
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:14278",
    trace: { mode: "retain-on-failure", screenshots: false },
  },
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: "VITE_ENABLE_MOCK=true bun run dev -- --host 127.0.0.1 --port 14278 --strictPort",
          url: "http://127.0.0.1:14278",
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
})
