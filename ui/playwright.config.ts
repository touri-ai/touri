import { defineConfig } from "@playwright/test"

const port = Number(process.env.TOURI_E2E_PORT ?? 1420)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 20_000,
  // Keep repeatable before/after transcript evidence in the serialized test gate.
  ...(process.env.TOURI_E2E_GREP || process.env.CHAT_TRANSCRIPT_PHASE
    ? { grep: new RegExp(process.env.TOURI_E2E_GREP ?? "chat activity:|mermaid", "i") }
    : {}),
  use: {
    channel: process.env.TOURI_E2E_CHANNEL ?? "chrome",
    headless: true,
    baseURL,
    trace: { mode: "retain-on-failure", screenshots: false },
  },
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: `VITE_ENABLE_MOCK=true bun run dev -- --host 127.0.0.1 --port ${port}`,
          url: baseURL,
          reuseExistingServer: !process.env.TOURI_E2E_PORT,
          timeout: 30_000,
        },
      }),
})
