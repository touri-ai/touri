import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  ...(process.env.TOURI_VITE_CACHE_DIR ? { cacheDir: process.env.TOURI_VITE_CACHE_DIR } : {}),
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./test/setup.ts",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  },
})
