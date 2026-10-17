import { defineConfig } from "@playwright/test"
import config from "./playwright.config"

export default defineConfig({
  ...config,
  testMatch: ["native-r6-polish.spec.ts", "repeat-task.spec.ts", "error-contract.spec.ts"],
  timeout: 60_000,
  workers: 1,
  use: { ...config.use, channel: undefined },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
})
