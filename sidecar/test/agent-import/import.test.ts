import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentImportPreview, AgentImportResult, Bot, Routine } from "@touri/contracts"
import { createAgentImportRoutes } from "../../src/agent-import/routes"
import { allItems, installImportCleanup, makeHarness, makePayload, makeSession, waitFor } from "./harness"

installImportCleanup()

test("manual preview writes nothing; apply copies selected resources, pauses routines and supports durable undo", async () => {
  const fixture = await makeHarness()
  const before = fixture.database.query("SELECT count(*) AS count FROM bots").get()
  const response = await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
  const preview = (await response.json()) as AgentImportPreview

  expect(response.status).toBe(200)
  expect(preview.agents[0]).toMatchObject({ name: "Notas", memories: 1, integrations: ["Calendário"] })
  expect(fixture.database.query("SELECT count(*) AS count FROM bots").get()).toEqual(before)
  expect(await readdir(fixture.runtime.kernel.paths.botsDir)).toEqual([])
  expect(fixture.database.query("SELECT key FROM settings WHERE key LIKE 'agent-import:%'").all()).toEqual([])

  const applied = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { [preview.agents[0]?.key ?? ""]: allItems },
  })
  const result = (await applied.json()) as AgentImportResult
  const botId = result.bots[0]?.botId ?? ""
  const bot = fixture.runtime.kernel.services.use("store.api")?.getBot({ botId })
  const routines = (await (await fixture.request("GET", "/routines")).json()) as { routines: Routine[] }

  expect(applied.status).toBe(200)
  expect(bot).toMatchObject({
    name: "Notas",
    roleLine: "Organiza notas",
    paused: false,
    access: "read-only",
    browserEnabled: false,
    computerUse: false,
  })
  expect(result).toMatchObject({ pausedRoutines: 1, reconnect: ["Calendário"] })
  expect(routines.routines).toHaveLength(1)
  expect(routines.routines[0]).toMatchObject({ enabled: false, botId })
  expect(await readFile(join(bot?.homeDir ?? "", "MEMORY.md"), "utf8")).toBe("O projeto usa português.")
  expect(await readFile(join(bot?.homeDir ?? "", "skills", "resumir", "SKILL.md"), "utf8")).toContain("Resuma o texto.")
  expect(fixture.events.filter((event) => event.type === "agent.import.progress").map((event) => event.step)).toEqual([
    "instructions",
    "skills",
    "memories",
    "routines",
    "done",
  ])

  const repeated = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { [preview.agents[0]?.key ?? ""]: allItems },
  })

  expect(await repeated.json()).toEqual(result)
  expect(((await (await fixture.request("GET", "/bots")).json()) as { bots: Bot[] }).bots).toHaveLength(1)

  const restartedRoutes = createAgentImportRoutes(fixture.runtime.kernel, { home: fixture.home })
  fixture.runtime.kernel.registerRoutes(restartedRoutes)
  const undoRoute = restartedRoutes.routes.find((route) => route.path === "/import/undo")
  const undone = await undoRoute?.handler({
    body: { importId: result.importId },
    params: {},
    query: {},
    signal: new AbortController().signal,
  })
  await waitFor(() => !fixture.database.query("SELECT id FROM bots WHERE id = ?").get(botId))

  expect(undone).toMatchObject({ status: 200, json: { removedBots: 1 } })
  expect(((await (await fixture.request("GET", "/routines")).json()) as { routines: Routine[] }).routines).toEqual([])
  expect(await readdir(fixture.runtime.kernel.paths.botsDir)).toEqual([])
  expect(fixture.database.query("PRAGMA foreign_key_check").all()).toEqual([])
})

test("folder copy preserves the source and does not touch an existing bot when undone", async () => {
  const fixture = await makeHarness()
  const instructionsPath = await fixture.write("export/instructions.md", "Ajude com revisão de texto.")
  await fixture.write("export/skills/revisar/SKILL.md", "Revise o texto com cuidado.")
  await fixture.write("export/skills/revisar/references/guide.md", "Prefira voz ativa.")
  await fixture.write("export/memory/preferences.md", "Use frases curtas.")
  await fixture.write(
    "export/jobs.json",
    JSON.stringify([{ name: "Revisão", schedule: "0 9 * * *", prompt: "Revise o trabalho." }]),
  )
  const existing = (await (
    await fixture.request("POST", "/bots", { name: "Existente", provider: "claude", machine: "local" })
  ).json()) as { bot: Bot }
  const preview = (await (
    await fixture.request("POST", "/import/preview", { source: "folder", path: join(fixture.home, "export") })
  ).json()) as AgentImportPreview
  const result = (await (
    await fixture.request("POST", "/import/apply", {
      previewId: preview.previewId,
      select: { [preview.agents[0]?.key ?? ""]: allItems },
    })
  ).json()) as AgentImportResult
  const bot = fixture.runtime.kernel.services.use("store.api")?.getBot({ botId: result.bots[0]?.botId ?? "" })

  expect(preview.agents[0]).toMatchObject({
    instructions: { files: 1 },
    skills: [{ name: "revisar" }],
    memories: 1,
    routines: [{ schedule: "0 9 * * *" }],
  })
  expect(await readFile(instructionsPath, "utf8")).toBe("Ajude com revisão de texto.")
  expect(await readFile(join(bot?.homeDir ?? "", "skills/revisar/references/guide.md"), "utf8")).toBe(
    "Prefira voz ativa.",
  )

  const undo = await fixture.request("POST", "/import/undo", { importId: result.importId })
  await waitFor(() => !fixture.database.query("SELECT id FROM bots WHERE id = ?").get(bot?.id ?? ""))

  expect(undo.status).toBe(200)
  expect(fixture.runtime.kernel.services.use("store.api")?.getBot({ botId: existing.bot.id })?.name).toBe("Existente")
  expect(await readFile(instructionsPath, "utf8")).toBe("Ajude com revisão de texto.")
})

test("undo removes routine history through progressive bot deletion without synchronous routine removal", async () => {
  const fixture = await makeHarness()
  const preview = (await (
    await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
  ).json()) as AgentImportPreview
  const result = (await (
    await fixture.request("POST", "/import/apply", {
      previewId: preview.previewId,
      select: Object.fromEntries(preview.agents.map(({ key }) => [key, allItems])),
    })
  ).json()) as AgentImportResult
  const botId = result.bots[0]?.botId ?? ""
  const routine = fixture.database.query("SELECT id FROM routines WHERE bot_id = ?").get(botId) as { id: string } | null
  const routines = fixture.runtime.kernel.services.use("agentImport.routines")
  if (!routine || !routines) throw new Error("Missing imported routine")
  fixture.database
    .query(`WITH RECURSIVE slots(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM slots WHERE n < 512
  ) INSERT INTO routine_runs(id, routine_id, scheduled_for, status, trigger_source)
    SELECT 'fixture-run-' || n, ?, n, 'succeeded', 'import' FROM slots`)
    .run(routine.id)
  const guardedRoutines = {
    create: routines.create,
    remove: () => {
      throw new Error("Synchronous routine history removal is forbidden")
    },
  }
  fixture.runtime.kernel.services.provide("agentImport.routines", guardedRoutines)

  const response = await fixture.request("POST", "/import/undo", { importId: result.importId })

  expect(response.status).toBe(200)
  await waitFor(() => !fixture.database.query("SELECT id FROM bots WHERE id = ?").get(botId))

  expect(await response.json()).toEqual({ removedBots: 1 })
  expect(fixture.database.query("SELECT id FROM routines WHERE id = ?").get(routine.id)).toBeNull()
  expect(
    fixture.database.query("SELECT count(*) AS count FROM routine_runs WHERE routine_id = ?").get(routine.id),
  ).toEqual({
    count: 0,
  })
})

test("owner identity is required for all four routes, including other administrators and expired sessions", async () => {
  const fixture = await makeHarness()
  const routes = [
    ["GET", "/import/sources"],
    ["POST", "/import/preview"],
    ["POST", "/import/apply"],
    ["POST", "/import/undo"],
  ]
  const sessions = [
    makeSession("member", "member"),
    makeSession("other-admin"),
    { ...makeSession(), active: () => false },
    { deviceId: "no-person", active: () => true },
  ]

  for (const [method, path] of routes) {
    for (const session of sessions) {
      const response = await fixture.dispatch(method ?? "", path ?? "", {}, session)

      expect(response.status).toBe(403)
    }
  }

  const owner = await fixture.dispatch(
    "POST",
    "/import/preview",
    { source: "manual", payload: makePayload() },
    makeSession(),
  )

  expect(owner.status).toBe(200)
})

test("the authenticated local owner can preview, apply and undo with work authorization installed", async () => {
  const fixture = await makeHarness()
  fixture.runtime.kernel.services.provide("work.authorizeHttp", () => ({
    status: 403,
    json: { errorCode: "FORBIDDEN" },
  }))

  const sources = await fixture.request("GET", "/import/sources")
  const previewResponse = await fixture.request("POST", "/import/preview", {
    source: "manual",
    payload: makePayload(),
  })
  const preview = (await previewResponse.json()) as AgentImportPreview

  expect(sources.status).toBe(200)
  expect(previewResponse.status).toBe(200)

  const applied = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: Object.fromEntries(preview.agents.map(({ key }) => [key, allItems])),
  })
  const result = (await applied.json()) as AgentImportResult

  expect(applied.status).toBe(200)

  const undone = await fixture.request("POST", "/import/undo", { importId: result.importId })
  const unauthenticated = await fetch(`http://127.0.0.1:${fixture.runtime.handshake.port}/api/v1/import/sources`)

  expect(undone.status).toBe(200)
  expect(await undone.json()).toEqual({ removedBots: 1 })
  expect(unauthenticated.status).toBe(401)
})

test("preview expires and invalid selections cannot create bots", async () => {
  let time = 1000
  const fixture = await makeHarness({ now: () => time })
  const preview = (await (
    await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
  ).json()) as AgentImportPreview
  const invalid = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { "agent-unknown": allItems },
  })
  time = preview.expiresAt

  const expired = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { [preview.agents[0]?.key ?? ""]: allItems },
  })

  expect(invalid.status).toBe(400)
  expect(expired.status).toBe(410)
  expect(((await (await fixture.request("GET", "/bots")).json()) as { bots: Bot[] }).bots).toEqual([])
})

test("unchecked categories create no artifacts and undo is idempotent", async () => {
  const fixture = await makeHarness()
  const preview = (await (
    await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
  ).json()) as AgentImportPreview
  const result = (await (
    await fixture.request("POST", "/import/apply", {
      previewId: preview.previewId,
      select: {
        [preview.agents[0]?.key ?? ""]: { instructions: false, skills: false, memories: false, routines: false },
      },
    })
  ).json()) as AgentImportResult
  const botId = result.bots[0]?.botId ?? ""
  const instructions = await (await fixture.request("GET", `/bots/${botId}/instructions`)).text()

  expect(instructions).toBe("")
  expect(result.pausedRoutines).toBe(0)

  await fixture.request("POST", "/import/undo", { importId: result.importId })
  await waitFor(() => !fixture.database.query("SELECT id FROM bots WHERE id = ?").get(botId))
  const repeated = await fixture.request("POST", "/import/undo", { importId: result.importId })

  expect(await repeated.json()).toEqual({ removedBots: 0 })
})

test("apply uses reviewed content even when the source changes and preserves large memories", async () => {
  const fixture = await makeHarness()
  const memory = "Contexto de exemplo. ".repeat(250)
  await fixture.write("export/instructions.md", "Primeira versão revisada.")
  await fixture.write("export/memory/facts.md", memory)
  const preview = (await (
    await fixture.request("POST", "/import/preview", { source: "folder", path: join(fixture.home, "export") })
  ).json()) as AgentImportPreview
  await fixture.write("export/instructions.md", "Segunda versão não revisada.")

  const response = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { [preview.agents[0]?.key ?? ""]: allItems },
  })
  const result = (await response.json()) as AgentImportResult
  const botId = result.bots[0]?.botId ?? ""
  const bot = fixture.runtime.kernel.services.use("store.api")?.getBot({ botId })
  const instructions = await (await fixture.request("GET", `/bots/${botId}/instructions`)).text()

  expect(response.status).toBe(200)
  expect(instructions).toContain("Primeira versão revisada.")
  expect(instructions).not.toContain("Segunda versão não revisada.")
  expect(await readFile(join(bot?.homeDir ?? "", "memory/imported-1.md"), "utf8")).toBe(memory)
  expect((await readFile(join(bot?.homeDir ?? "", "MEMORY.md"), "utf8")).length).toBeLessThanOrEqual(3000)
})

test("a copy failure rolls back the newly created bot and does not duplicate it on retry", async () => {
  const fixture = await makeHarness()
  const preview = (await (
    await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
  ).json()) as AgentImportPreview
  const createBot = fixture.runtime.kernel.services.use("agentImport.createBot")
  if (!createBot) throw new Error("Missing service")
  fixture.runtime.kernel.services.provide("agentImport.createBot", async (input) => {
    const bot = await createBot(input)
    // Invalid destination simulates a worker write refusal after bot creation.
    return bot ? { ...bot, homeDir: "/invalid-import-fixture" } : null
  })

  const response = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { [preview.agents[0]?.key ?? ""]: allItems },
  })
  await waitFor(() => !fixture.database.query("SELECT id FROM bots LIMIT 1").get())
  const retry = await fixture.request("POST", "/import/apply", {
    previewId: preview.previewId,
    select: { [preview.agents[0]?.key ?? ""]: allItems },
  })

  expect(response.status).toBe(500)
  expect(retry.status).toBe(410)
  expect(fixture.events.some((event) => event.type === "agent.import.progress" && event.step === "failed")).toBe(true)
})

test("concurrent source previews are serialized and concurrent apply retries create one bot", async () => {
  const fixture = await makeHarness()
  const responses = await Promise.all(
    [1, 2].map(() => fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })),
  )
  const previews = await Promise.all(responses.map((response) => response.json() as Promise<AgentImportPreview>))
  const preview = previews[0]
  if (!preview) throw new Error("Missing preview")

  const applied = await Promise.all(
    [1, 2].map(() =>
      fixture.request("POST", "/import/apply", {
        previewId: preview.previewId,
        select: { [preview.agents[0]?.key ?? ""]: allItems },
      }),
    ),
  )
  const results = await Promise.all(applied.map((response) => response.json() as Promise<AgentImportResult>))

  expect(responses.map((response) => response.status)).toEqual([200, 200])
  expect(previews[0]?.agents[0]?.key).not.toBe(previews[1]?.agents[0]?.key)
  expect(applied.map((response) => response.status)).toEqual([200, 200])
  expect(results[0]).toEqual(results[1])
  expect(((await (await fixture.request("GET", "/bots")).json()) as { bots: Bot[] }).bots).toHaveLength(1)
})

test("applies reviewed names to two sources with the same agent name", async () => {
  const fixture = await makeHarness()
  const previews = await Promise.all(
    ["first", "second"].map(async () => {
      const response = await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
      return (await response.json()) as AgentImportPreview
    }),
  )

  for (const [index, preview] of previews.entries()) {
    const key = preview.agents[0]?.key ?? ""
    const response = await fixture.request("POST", "/import/apply", {
      previewId: preview.previewId,
      select: { [key]: allItems },
      names: { [key]: `Notas ${index + 1}` },
    })
    expect(response.status).toBe(200)
  }

  const response = await fixture.request("GET", "/bots")
  const { bots } = (await response.json()) as { bots: Bot[] }
  expect(new Set(bots.map((bot) => bot.name))).toEqual(new Set(["Notas 1", "Notas 2"]))
})

test("rejects invalid reviewed names and keys before writing bots", async () => {
  const fixture = await makeHarness()
  const response = await fixture.request("POST", "/import/preview", { source: "manual", payload: makePayload() })
  const preview = (await response.json()) as AgentImportPreview
  const key = preview.agents[0]?.key ?? ""

  for (const names of [{ [key]: "" }, { [key]: "bad\nname" }, { other: "Notas" }]) {
    const response = await fixture.request("POST", "/import/apply", {
      previewId: preview.previewId,
      select: { [key]: allItems },
      names,
    })
    expect(response.status).toBe(400)
  }

  const bots = (await (await fixture.request("GET", "/bots")).json()) as { bots: Bot[] }
  expect(bots.bots).toHaveLength(0)
})
