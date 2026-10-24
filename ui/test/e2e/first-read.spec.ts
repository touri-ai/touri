import { spawn } from "node:child_process"
import { access, copyFile } from "node:fs/promises"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { expect, test } from "@playwright/test"
import { createServerModeFixture } from "./server-mode-fixture"

const probes = new Set<{ stop: () => void; done: Promise<void> }>()
const servers = new Set<Awaited<ReturnType<typeof createServerModeFixture>>>()
test.afterEach(async () => {
  for (const probe of probes) probe.stop()
  await Promise.allSettled(Array.from(probes, (probe) => probe.done))
  probes.clear()
  for (const server of servers) await server.dispose()
  servers.clear()
})
test.setTimeout(300_000)
test.skip(
  process.env.TOURI_FIRST_READ_COLD !== "1" || process.platform !== "linux",
  "Opt-in Linux cold-storage benchmark; requires Python 3 and a separately built CLI",
)
// Performance samples match the untraced QA browser; screenshots and resource timings remain enabled.
test.use({ trace: "off" })

const run = (executable: string, args: string[]): Promise<string> =>
  new Promise((done, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000)
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk))
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`Synthetic fixture failed: ${Buffer.concat(errors).toString()}`))
      done(Buffer.concat(output).toString())
    })
  })

test("cold selected channel history is readable within one second with a preserved draft", async ({ page }, info) => {
  const executable =
    process.env.FIRST_READ_CLI ?? resolve(import.meta.dirname, "../../../dist/touri-linux-x64-baseline")
  await access(executable).catch(() => {
    throw new Error("Build the CLI before enabling the cold-storage benchmark")
  })
  const server = await createServerModeFixture({ port: await getFreePort(), executable })
  servers.add(server)
  const settings = await server.api("/settings")
  const { bot } = await server.api("/bots", "POST", {
    name: "Equipe fictícia",
    provider: settings.settings.defaultProvider,
  })
  const { thread } = await server.api("/groups", "POST", {
    name: "Canal fictício",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: [bot.id],
    coordinatorBotId: null,
  })
  await server.stop()
  await run("bun", [resolve(import.meta.dirname, "first-read-fixture.ts"), server.dataDir, thread.id])
  await server.install(page)
  await page.addInitScript(
    ({ botId, threadId }) => {
      localStorage.setItem("touri.workspace.v1", JSON.stringify({ botId, threadId }))
      const state = { historyMs: 0, falseEmpty: false }
      Object.assign(window, { firstReadTiming: state })
      new MutationObserver(() => {
        const last = document.querySelector('[data-message-id="first-read-59"]')
        if (
          !state.historyMs &&
          last?.textContent?.includes("Registro fictício 59.") &&
          last.getBoundingClientRect().height
        )
          state.historyMs = performance.now()
        if (document.querySelector(".chat-panel")?.textContent?.includes("Comece a conversa")) state.falseEmpty = true
      }).observe(document, { childList: true, subtree: true, characterData: true })
    },
    { botId: bot.id, threadId: thread.id },
  )
  const network = await page.context().newCDPSession(page)
  await network.send("Network.enable")
  await network.send("Network.setCacheDisabled", { cacheDisabled: true })
  // Match QA: an existing browser session, then evict only the stopped fixture database before each timed navigation.
  await server.start()
  await page.goto(`${server.relayUrl}/?bot=${bot.id}&thread=${thread.id}`)
  await expect(page.locator('[data-message-id="first-read-59"]')).toBeVisible({ timeout: 10000 })
  await page
    .getByRole("textbox", { name: "Mensagem para Canal fictício", exact: true })
    .fill("Rascunho fictício preservado.")
  const metrics = []
  for (const [index, width] of [1440, 1440, 390].entries()) {
    await page.goto("about:blank")
    await server.stop()
    const cache = JSON.parse(
      await run("python3", [resolve(import.meta.dirname, "first-read-cold.py"), resolve(server.dataDir, "touri.db")]),
    )
    expect(cache.resident).toBe(0)
    await server.start()
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    // This sample owns its probe lifetime and timing accumulators.
    let probing = true
    const health: number[] = []
    const probe = (async () => {
      while (probing) {
        const started = performance.now()
        await server.api("/health")
        health.push(performance.now() - started)
        await new Promise((done) => setTimeout(done, 100))
      }
    })()
    const activeProbe = {
      stop: () => {
        probing = false
      },
      done: probe,
    }
    probes.add(activeProbe)
    await page.goto(`${server.relayUrl}/?bot=${bot.id}&thread=${thread.id}`)
    await expect(page.locator('[data-message-id="first-read-59"]')).toBeVisible({ timeout: 10000 })
    probing = false
    await probe
    probes.delete(activeProbe)
    const observation = await page.evaluate(() => {
      const state = (window as Window & { firstReadTiming: { historyMs: number; falseEmpty: boolean } }).firstReadTiming
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      return {
        ...state,
        resources: resources
          .filter((row) => row.name.includes("/api/v1/") || row.name.includes("/assets/index-"))
          .map((row) => ({
            path: new URL(row.name).pathname,
            startMs: row.startTime,
            endMs: row.responseEnd,
            durationMs: row.duration,
          })),
      }
    })
    const composer = page.getByRole("textbox", { name: "Mensagem para Canal fictício", exact: true })
    await expect(composer).toHaveValue("Rascunho fictício preservado.")
    expect(observation.falseEmpty).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const screenshot = info.outputPath(`first-read-${index}-${width}.png`)
    await page.screenshot({ path: screenshot, mask: [page.locator(".model-picker-trigger-label")] })
    await info.attach(`first-read-${index}-${width}.png`, { path: screenshot, contentType: "image/png" })
    if (process.env.TOURI_EVIDENCE_DIR)
      await copyFile(screenshot, resolve(process.env.TOURI_EVIDENCE_DIR, `first-read-${index}-${width}.png`))
    const snapshot = await server.api(`/threads/${thread.id}/messages?all=true`)
    expect(snapshot.messages).toHaveLength(60)
    expect(observation.historyMs).toBeGreaterThan(0)
    metrics.push({ width, cache, observation, healthMaxMs: Math.max(...health) })
    console.log(JSON.stringify(metrics.at(-1)))
  }
  await info.attach("first-read-metrics.json", { body: JSON.stringify(metrics), contentType: "application/json" })
  expect(metrics.every((sample) => sample.observation.historyMs > 0 && sample.observation.historyMs < 1000)).toBe(true)
})

const getFreePort = async (): Promise<number> => {
  for (let port = 18800; port <= 18899; port++) {
    const server = createServer()
    const available = await new Promise<boolean>((done, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") return done(false)
        reject(error)
      })
      server.listen(port, "127.0.0.1", () => server.close(() => done(true)))
    })
    if (available) return port
  }
  throw new Error("No free staging port in the benchmark range")
}
