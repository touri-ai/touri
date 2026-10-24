import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import type { Bot, BotGroup, Thread } from "@touri/contracts"
import seed from "../../../sidecar/test/fixtures/ui-seed.json" with { type: "json" }
import { createWorkGoldenServer } from "./work-golden-server"

type Task = { name: string; tid: number; dur?: number; tdur?: number; args?: { name?: string } }

let server: Awaited<ReturnType<typeof createWorkGoldenServer>> | null = null
let releaseGroups: () => void = () => undefined
test.setTimeout(180_000)
test.use({ trace: "off" })

test.afterEach(async () => {
  releaseGroups()
  await server?.dispose()
  server = null
})

test("saved history opening records request and renderer boundaries", async ({ page }, info) => {
  const current = await createWorkGoldenServer()
  server = current
  const { group, thread } = await seedHistory(current)
  let query: unknown = null
  await current.restart(async (directory) => {
    query = await getQueryTiming(directory, thread.id)
  })
  await current.install(page)
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const transcript = document.querySelector('[data-testid="virtual-message-list"]')
      if (!transcript?.textContent?.includes("Último registro sintético.")) return

      performance.mark("selected-history-visible")
      observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true, characterData: true })
  })
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("region", { name: "Canais", exact: true }).getByText(group.name, { exact: true }).click()
  await page.getByRole("region", { name: "Canais", exact: true }).getByText(thread.title, { exact: true }).click()
  await expect(
    page.getByTestId("virtual-message-list").getByText("Último registro sintético.", { exact: true }),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.entries(localStorage).some(
          ([key, value]) => key.includes("work-channels") && value.includes("Conversa selecionada"),
        ),
      ),
    )
    .toBe(true)
  const session = await page.context().newCDPSession(page)
  await session.send("Performance.enable")
  const samples = []

  for (const width of [1440, 390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    // The tracing callback owns this bounded, synthetic opening sample; arguments are never retained.
    const tasks: Task[] = []
    const rendererThreads = new Set<number>()
    const record = ({ value }: { value: Task[] }) => {
      value
        .filter(({ name, args }) => name === "thread_name" && args?.name === "CrRendererMain")
        .forEach(({ tid }) => {
          rendererThreads.add(tid)
        })
      tasks.push(
        ...value
          .filter(({ name }) => name.endsWith("RunTask"))
          .slice(0, 5000 - tasks.length)
          .map(({ name, tid, dur, tdur }) => ({ name, tid, dur, tdur })),
      )
    }
    session.on("Tracing.dataCollected", record)
    await session.send("Tracing.start", { categories: "toplevel", transferMode: "ReportEvents" })
    await page.goto(current.serverUrl)
    await expect(
      page.getByTestId("virtual-message-list").getByText("Último registro sintético.", { exact: true }),
    ).toBeVisible()
    const { metrics } = await session.send("Performance.getMetrics")
    const resources = await page.evaluate(() => ({
      visibleMs: performance.getEntriesByName("selected-history-visible")[0]?.startTime ?? null,
      resources: performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/api/v1/"))
        .map((entry) => {
          const timing = entry as PerformanceResourceTiming
          return {
            path: new URL(timing.name).pathname.replace(/\/(bots|groups|threads)\/[^/]+/g, "/$1/:id"),
            startMs: timing.startTime,
            requestMs: timing.requestStart,
            responseStartMs: timing.responseStart,
            responseEndMs: timing.responseEnd,
            bytes: timing.decodedBodySize,
          }
        }),
    }))
    const traceComplete = new Promise<void>((done) => session.once("Tracing.tracingComplete", () => done()))
    await session.send("Tracing.end")
    await traceComplete
    session.off("Tracing.dataCollected", record)
    samples.push({
      width,
      ...resources,
      tasks: getTaskSummary(tasks.filter(({ tid }) => rendererThreads.has(tid))),
      renderer: metrics.filter(({ name }) =>
        ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].includes(name),
      ),
    })
  }

  const summary = JSON.stringify(
    { synthetic: { bots: 9, channels: 3, conversations: 135, selectedMessages: 27 }, query, samples },
    null,
    2,
  )
  await info.attach("selected-history-boundaries", { body: summary, contentType: "application/json" })
  if (process.env.TOURI_HISTORY_EVIDENCE) {
    await mkdir(process.env.TOURI_HISTORY_EVIDENCE, { recursive: true })
    await writeFile(join(process.env.TOURI_HISTORY_EVIDENCE, "boundaries.json"), summary)
  }
  console.log(summary)
})

const getTaskSummary = (tasks: Task[]) => {
  const cpu = tasks
    .flatMap(({ tdur }) => (tdur === undefined ? [] : [tdur / 1000]))
    .toSorted((left, right) => left - right)
  const largest = tasks.toSorted((left, right) => (right.dur ?? 0) - (left.dur ?? 0))[0]

  return {
    count: tasks.length,
    withCpu: cpu.length,
    cpuSumMs: cpu.reduce((total, duration) => total + duration, 0),
    cpuP99Ms: cpu[Math.floor(cpu.length * 0.99)] ?? null,
    cpuMaxMs: cpu.at(-1) ?? null,
    largestWallMs: (largest?.dur ?? 0) / 1000,
    largestCpuMs: largest?.tdur === undefined ? null : largest.tdur / 1000,
  }
}

const getQueryTiming = (directory: string, threadId: string): Promise<unknown> =>
  new Promise((done, reject) => {
    const child = spawn("bun", [join(import.meta.dirname, "selected-history-query.ts"), directory, threadId], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      killSignal: "SIGKILL",
    })
    // The fixture emits only a bounded plan and aggregate timings, never rows or credentials.
    const chunks: string[] = []
    child.stdout.on("data", (chunk) => chunks.push(String(chunk)))
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code !== 0) return reject(new Error("Synthetic query probe failed"))

      done(JSON.parse(chunks.join("")))
    })
  })

test("a saved channel opens authorized history while its channel list remains pending", async ({ page }) => {
  const current = await createWorkGoldenServer()
  server = current
  const { group, thread } = await seedHistory(current, false)
  await current.install(page)
  await page.goto(current.serverUrl)
  await page.getByRole("tab", { name: /^Work,/ }).click()
  await page.getByRole("region", { name: "Canais", exact: true }).getByText(group.name, { exact: true }).click()
  await expect(
    page.getByTestId("virtual-message-list").getByText("Último registro sintético.", { exact: true }),
  ).toBeVisible()
  const composer = page.getByRole("textbox", { name: new RegExp(`Mensagem (?:para |em #)${group.name}`) })
  await composer.fill("Rascunho de demonstração")
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          Object.entries(localStorage).some(
            ([key, value]) => key.includes("work-channels") && JSON.parse(value).selectedThreadId === id,
          ),
        thread.id,
      ),
    )
    .toBe(true)
  const groups = new Promise<void>((done) => {
    releaseGroups = done
  })
  let groupListPending = false
  await page.route("**/api/v1/groups", async (route) => {
    groupListPending = true
    await groups
    await route.continue().catch(() => undefined)
  })

  await page.reload()
  await expect(
    page.getByTestId("virtual-message-list").getByText("Último registro sintético.", { exact: true }),
  ).toBeVisible()

  expect(groupListPending).toBe(true)
  await expect(composer).toHaveValue("Rascunho de demonstração")
  await expect(page.getByRole("region", { name: `Comece a conversa em #${group.name}` })).toHaveCount(0)
  if (process.env.TOURI_HISTORY_EVIDENCE) {
    await mkdir(process.env.TOURI_HISTORY_EVIDENCE, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      await page.screenshot({
        path: join(process.env.TOURI_HISTORY_EVIDENCE, `saved-history-${width}.png`),
        animations: "disabled",
        mask: [page.locator(".model-picker-trigger-label")],
        maskColor: "#dddde2",
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
  }
  releaseGroups()
})

const seedHistory = async (current: Awaited<ReturnType<typeof createWorkGoldenServer>>, large = true) => {
  const bots = await Promise.all(
    Array.from({ length: large ? 9 : 1 }, async (_, index) => {
      const { bot } = (await current.api("/bots", "POST", {
        name: `Assistente ${index + 1}`,
        provider: seed.bots[0]?.provider,
        access: "read-only",
        approvals: "on-request",
      })) as { bot: Bot }
      return bot
    }),
  )
  const channels = await Promise.all(
    Array.from(
      { length: large ? 3 : 1 },
      async (_, index) =>
        current.api("/groups", "POST", {
          name: `Planejamento ${index + 1}`,
          color: "#558866",
          avatarShape: "cercle",
          memberIds: bots.filter((_, botIndex) => botIndex % 3 === index).map(({ id }) => id),
          coordinatorBotId: null,
        }) as Promise<{ group: BotGroup; thread: Thread }>,
    ),
  )
  for (const channel of channels) {
    for (const index of Array.from({ length: large ? 44 : 0 }, (_, index) => index)) {
      await current.api(`/groups/${channel.group.id}/threads`, "POST", { title: `Conversa ${index + 1}` })
    }
  }
  const selected = channels[0]
  if (!selected) throw new Error("Missing synthetic channel")
  const { threads } = (await current.api(`/groups/${selected.group.id}/threads`)) as { threads: Thread[] }
  const target = large ? threads.find(({ id }) => id !== selected.thread.id) : selected.thread
  if (!target) throw new Error("Missing selected synthetic conversation")
  const { thread } = (await current.api(`/threads/${target.id}`, "PATCH", {
    title: "Conversa selecionada",
  })) as { thread: Thread }
  for (const index of Array.from({ length: large ? 27 : 1 }, (_, index) => index)) {
    await current.api(`/threads/${thread.id}/messages`, "POST", {
      text:
        index === (large ? 26 : 0)
          ? "Último registro sintético."
          : `Registro ${index + 1}. ${"O planejamento de demonstração continua salvo para a equipe. ".repeat(48)}`,
      parentId: null,
      attachmentIds: [],
      sendId: crypto.randomUUID(),
    })
  }
  return { group: selected.group, thread }
}
