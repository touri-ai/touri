import { defineConfig } from "@playwright/test"

const port = Number(process.env.TOURI_E2E_PORT ?? 14278)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  reportSlowTests: { max: 10, threshold: 1_000 },
  testDir: "./test/e2e",
  ...(process.env.UPDATE_SNAPSHOTS ? { updateSnapshots: "all" as const } : {}),
  globalSetup: "./test/e2e/global-setup.ts",
  timeout: 20_000,
  // Production builds and CPU/heap budgets share the host; simultaneous specs distort their measurements.
  projects: [{ workers: 1 }],
  // Keep repeatable before/after transcript evidence in the serialized test gate.
  ...(process.env.TOURI_E2E_GREP || process.env.CHAT_TRANSCRIPT_PHASE
    ? { grep: new RegExp(process.env.TOURI_E2E_GREP ?? "chat activity:|mermaid", "i") }
    : {}),
  use: {
    ...(process.env.TOURI_E2E_CHANNEL ? { channel: process.env.TOURI_E2E_CHANNEL } : {}),
    headless: true,
    // Pages follow the system theme by default; existing captures were made against a dark system.
    colorScheme: "dark",
    baseURL,
    trace: { mode: "retain-on-failure", screenshots: false },
  },
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: `VITE_ENABLE_MOCK=true bun run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }),
})
