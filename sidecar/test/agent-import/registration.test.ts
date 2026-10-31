import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { init as initImporter } from "../../src/importer"
import { createKernel, type KernelRuntime } from "../../src/kernel"

const resources = new Set<{ runtime: KernelRuntime; root: string }>()
afterEach(async () => {
  for (const { runtime, root } of resources) {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
  resources.clear()
})

test("normal importer initialization registers the shared agent preview API without writing bots", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-import-registration-"))
  const runtime = createKernel({ appData: root })
  resources.add({ runtime, root })
  await initImporter(runtime.kernel)

  const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/import/preview`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-ui-token", "Content-Type": "application/json", "x-touri-client": "fixture" },
    body: JSON.stringify({
      source: "manual",
      payload: {
        agents: [
          {
            name: "Notas",
            personality: "Organiza notas",
            instructions: "Ajude com notas.",
            skills: [],
            memories: [],
            routines: [],
            integrations: [],
          },
        ],
      },
    }),
  })
  const preview = (await response.json()) as { agents?: { name: string }[] }

  expect(response.status).toBe(200)
  expect(preview.agents?.[0]?.name).toBe("Notas")
})
