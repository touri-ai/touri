import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  ...(process.env.TOURI_VITE_CACHE_DIR ? { cacheDir: process.env.TOURI_VITE_CACHE_DIR } : {}),
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
})
