import { resolve } from "node:path"
import { build } from "vite"

export default async function setup() {
  const root = resolve(import.meta.dirname, "../..")

  // Build once before browser workloads so compilation never contaminates their timing or memory samples.
  await build({ root, configFile: resolve(root, "vite.config.ts"), build: { manifest: true } })
  console.log("UI production build: passed")
}
