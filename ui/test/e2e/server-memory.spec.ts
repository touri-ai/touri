import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { expect, test } from "@playwright/test"

const run = promisify(execFile)
const repository = resolve(import.meta.dirname, "../../..")
const configuredDuration = Number(process.env.TOURI_MEMORY_DURATION_MS ?? 15_000)

test.use({ channel: "chromium", trace: "off", viewport: { width: 1440, height: 900 } })
test.setTimeout(Math.max(configuredDuration, 15_000) + 120_000)

for (const scenario of ["regular", "large replies"] as const) {
  const duration = scenario === "regular" ? configuredDuration : 15_000
  const interval = scenario === "regular" ? Number(process.env.TOURI_MEMORY_EVENT_INTERVAL_MS ?? 30) : 500
  const repeats = scenario === "regular" ? 2500 : 75000
  test(`server memory stays bounded across background replies from 30 bots (${scenario})`, async ({
    page,
    context,
  }, testInfo) => {
    await mkdir(join(repository, "node_modules/.cache"), { recursive: true })
    const temporary = await mkdtemp(join(repository, "node_modules/.cache/touri-server-memory-"))
    let server: ChildProcess | undefined
    try {
      const listener = createServer()
      await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready))
      const address = listener.address()
      if (!address || typeof address === "string") throw new Error("No temporary port")
      const port = address.port
      await new Promise<void>((done) => listener.close(() => done()))
      const origin = `http://127.0.0.1:${port}`
      const dataDir = join(temporary, "data")
      server = spawn(
        "bun",
        [
          "--preload",
          "./ui/test/e2e/server-memory-preload.ts",
          "sidecar/src/cli/main.ts",
          "serve",
          "--data-dir",
          dataDir,
          "--port",
          String(port),
          "--ui-dir",
          "ui/dist",
        ],
        {
          cwd: repository,
          env: {
            ...process.env,
            TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
            TOURI_MEMORY_EVENT_INTERVAL_MS: String(interval),
            TOURI_MEMORY_DURATION_MS: String(duration),
            TOURI_MEMORY_REPLY_REPEATS: String(repeats),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      let output = ""
      server.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      server.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString()
      })
      await expect
        .poll(() => output.includes("listening on") || server?.exitCode !== null, { timeout: 30_000 })
        .toBe(true)
      expect(output.includes("listening on"), output).toBe(true)
      const pairing = await run("bun", ["run", "touri", "pair", "--data-dir", dataDir], { cwd: repository })
      const code = pairing.stdout.match(/Pairing code: ([A-Z0-9-]+)/)?.[1]
      expect(code).toBeTruthy()
      expect((await context.request.post(`${origin}/pair`, { data: { code, name: "Memory fixture" } })).ok()).toBe(true)
      await context.addInitScript(() =>
        localStorage.setItem(
          "touri.workspace.v1",
          JSON.stringify({
            botId: "memory-bot-0",
            threadId: "memory-thread-0",
          }),
        ),
      )
      const requests: Record<string, number> = {}
      const replyIds = new Set<string>()
      let events = 0
      let eventStreamReady = false
      page.on("websocket", (socket) =>
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload !== "string") return
          eventStreamReady = true
          const { event } = JSON.parse(payload) as { event?: { type?: string; message?: { id?: string } } }
          if (event?.type?.startsWith("message.")) events++
          if (event?.type === "message.created" && event.message?.id) replyIds.add(event.message.id)
        }),
      )
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname
        if (path.startsWith("/api/")) requests[path] = (requests[path] ?? 0) + 1
      })
      await page.goto(origin)
      await expect(page.locator(".composer-island textarea")).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => eventStreamReady).toBe(true)
      const cdp = await context.newCDPSession(page)
      await cdp.send("HeapProfiler.enable")
      const samples: Array<{ elapsedMs: number; usedBytes: number; nodes: number }> = []
      const started = Date.now()
      const sample = async () => {
        await cdp.send("HeapProfiler.collectGarbage")
        const heap = await cdp.send("Runtime.getHeapUsage")
        const dom = await cdp.send("Memory.getDOMCounters")
        samples.push({ elapsedMs: Date.now() - started, usedBytes: heap.usedSize, nodes: dom.nodes })
      }
      await sample()
      const commands = server.stdin
      if (!commands) throw new Error("Memory fixture control pipe is unavailable")

      commands.write("memory-fixture-start\n")
      await expect.poll(() => output.includes("Memory workload started")).toBe(true)
      expect(server.exitCode, output).toBeNull()
      while (Date.now() - started < duration) {
        await page.waitForTimeout(Math.min(30_000, duration - (Date.now() - started)))
        await sample()
      }
      expect(server.exitCode, output).toBeNull()
      // Duration is a minimum observation window; timer scheduling is not a throughput guarantee.
      const minimumReplies = Math.floor(duration / interval)
      await expect.poll(() => replyIds.size, { timeout: 30_000 }).toBeGreaterThanOrEqual(minimumReplies)
      await sample()
      const countResponse = await context.request.get(`${origin}/api/v1/threads/memory-thread-2/messages?all=true`)
      const history = (await countResponse.json()) as { messages: unknown[] }
      const result = {
        scenario,
        duration,
        interval,
        replies: replyIds.size,
        events,
        samples,
        requests,
        backgroundHistoryMessages: history.messages.length,
      }
      await writeFile(testInfo.outputPath("memory.json"), JSON.stringify(result, null, 2))
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.waitForTimeout(300)
      await page
        .getByRole("navigation", { name: "Barra lateral" })
        .screenshot({ path: testInfo.outputPath("memory.png") })
      console.log(JSON.stringify(result))
      expect(history.messages.length).toBeGreaterThan(1)
      expect(result.replies).toBeGreaterThanOrEqual(minimumReplies)
      expect(samples.at(-1)?.usedBytes ?? Infinity).toBeLessThan(24 * 1024 * 1024)
      expect((samples.at(-1)?.usedBytes ?? Infinity) - (samples[0]?.usedBytes ?? 0)).toBeLessThan(8 * 1024 * 1024)
      expect(Object.keys(requests).filter((path) => /\/threads\/.*\/messages/.test(path))).toEqual([
        "/api/v1/threads/memory-thread-0/messages",
      ])
    } finally {
      if (server && server.exitCode === null) {
        const exited = new Promise<void>((done) => server?.once("exit", () => done()))
        server.kill("SIGTERM")
        await exited
      }
      await rm(temporary, { recursive: true, force: true })
    }
  })
}
