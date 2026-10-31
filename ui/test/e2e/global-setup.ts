import { copyFile, mkdir, readdir } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { FullConfig } from "@playwright/test"
import { build } from "vite"

export default async function setup(config: FullConfig) {
  const root = resolve(import.meta.dirname, "../..")

  // Focused production fixtures compile their own entry before starting the workload.
  if (process.env.TOURI_E2E_FIXTURE_BUILDS_UI !== "1") {
    await build({
      root,
      configFile: resolve(root, "vite.config.ts"),
      build: {
        manifest: true,
        rollupOptions: {
          input: [
            resolve(root, "index.html"),
            resolve(root, "test/e2e/channel-takeover-harness.html"),
            resolve(root, "test/e2e/onboarding-guide-harness.html"),
            resolve(root, "test/e2e/browser-activity-harness.html"),
            resolve(root, "test/e2e/fixtures/travel-search.html"),
            resolve(root, "test/e2e/browser-outcome-harness.html"),
            resolve(root, "test/e2e/groups-harness.html"),
            resolve(root, "test/e2e/mermaid-harness.html"),
            resolve(root, "test/e2e/work-approval-harness.html"),
            resolve(root, "test/e2e/work-harness.html"),
            resolve(root, "test/e2e/channel-browser-harness.html"),
            resolve(root, "test/e2e/response-feedback-harness.html"),
          ],
        },
      },
    })
    console.log("UI production build: passed")
  }

  return async () => {
    const directory = process.env.TOURI_E2E_EVIDENCE_DIR
    if (!directory) return
    const destination = resolve(directory)
    await mkdir(destination, { recursive: true })
    for (const project of config.projects) {
      const source = resolve(project.outputDir)
      if (destination === source || destination.startsWith(`${source}${sep}`))
        throw new Error("Screenshot evidence must be outside the test output directory")
      await copyScreenshots(source, destination)
    }
  }
}

const copyScreenshots = async (source: string, destination: string, prefix = "artifacts-"): Promise<void> => {
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(source, entry.name)
    if (entry.isDirectory()) {
      await copyScreenshots(path, destination, `${prefix}${entry.name}-`)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".png")) await copyFile(path, join(destination, `${prefix}${entry.name}`))
  }
}
