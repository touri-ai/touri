import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LegacyBot } from "@touri/contracts"
import { runLegacyImport } from "../../src/importer/legacy/import"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const invalidModels = [
  "--help",
  " -config ",
  "demo\u0000model",
  "demo\tmodel",
  "demo\n",
  "demo\u200bmodel",
  "demo\u202emodel",
  "demo\ud800model",
  "demo\u034fmodel",
  "demo\ufe0fmodel",
  "m".repeat(257),
  42,
  false,
  {},
  ["demo-model"],
]

test.each(invalidModels.map((model) => [model]))(
  "rejects imported model %j without writing bots or sessions",
  async (model) => {
    const { run, database } = await makeFixture(model)

    await expect(run(true)).rejects.toThrow(
      "Use a model name of up to 256 characters, without hidden or control characters or a leading dash.",
    )
    await expect(run(false)).rejects.toThrow(
      "Use a model name of up to 256 characters, without hidden or control characters or a leading dash.",
    )

    expect(database.query("SELECT model FROM bots").all()).toEqual([])
    expect(database.query("SELECT model FROM provider_sessions").all()).toEqual([])
  },
)

test.each([null, "", "   ", " demo-model ", 'demo\\"=#[]{}', "provider/model:latest", "m".repeat(256)])(
  "preserves normalized model %j in imported bots and sessions",
  async (model) => {
    const { run, database } = await makeFixture(model)

    await run(false)

    const expected = model?.trim() || null
    expect(database.query("SELECT model FROM bots WHERE name = 'mark'").get()).toEqual({ model: expected })
    expect(database.query("SELECT model FROM provider_sessions").all()).toEqual([{ model: expected }])
  },
)

const makeFixture = async (model: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "touri-import-model-"))
  const source = join(root, "source")
  const runtime = createKernel({ appData: join(root, "app") })
  cleanups.add(async () => {
    runtime.stop()
    await rm(root, { recursive: true, force: true })
  })
  await cp(join(import.meta.dir, "../fixtures/legacy"), source, { recursive: true })
  const botsPath = join(source, "bots.json")
  const bots: LegacyBot[] = JSON.parse(await readFile(botsPath, "utf8"))
  const updated = bots.map((bot) => ({
    ...bot,
    modelSelection: { instanceId: "codex", model: bot.name === "mark" ? model : "--invalid-unselected" },
  }))
  await writeFile(botsPath, JSON.stringify(updated))
  const database = runtime.kernel.db as Database
  const run = (dryRun: boolean) =>
    runLegacyImport({
      kernel: runtime.kernel,
      importId: runtime.kernel.newId(),
      options: {
        source: { kind: "local", root: source },
        botIds: ["mark"],
        importCodexSessions: true,
        cwdMap: bots.flatMap((bot) => (bot.cwd ? [{ from: bot.cwd, to: root }] : [])),
        includeAttachments: false,
        dryRun,
      },
    })

  return { run, database }
}
