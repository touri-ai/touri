import { defineConfig } from "@playwright/test"
import config from "./playwright.config"

export default defineConfig({
  ...config,
  testMatch: "dialog-small-window.spec.ts",
  timeout: 60_000,
  workers: 2,
  use: { ...config.use, channel: undefined },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
})
