import type { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserSnapshot, ToolRegistration } from "@touri/contracts"
import { init } from "../../../sidecar/src/browser"
import { createBrowserEngine } from "../../../sidecar/src/browser/engine"
import { createHeadlessHost } from "../../../sidecar/src/cli/host/headlessHost"
import { createSecretStore } from "../../../sidecar/src/cli/host/secretStore"
import { createKernel } from "../../../sidecar/src/kernel"
import { startBrowserFixtureServer } from "../../../sidecar/test/browser/fixture-server"
import { createFixtureBrowserLauncher } from "./browser-fixture-launcher"

const root = await mkdtemp(join(tmpdir(), "touri-decisions-e2e-"))
const runtime = createKernel({ appData: join(root, "data") })
const secrets = createSecretStore({ dir: join(root, "vault"), env: { TOURI_SECRETS_KEY: "synthetic-encryption-key" } })
const host = createHeadlessHost({ secrets })({ publish: runtime.kernel.publish, log: runtime.kernel.log })
const handlers = new Map<string, ToolRegistration>()
const kernel = {
  ...runtime.kernel,
  callHost: host,
  registerTools: (input: Parameters<typeof runtime.kernel.registerTools>[0]) => {
    input.tools.forEach((tool) => {
      handlers.set(tool.name, tool)
    })
    return runtime.kernel.registerTools(input)
  },
}
const engine = createBrowserEngine({ kernel, launcher: createFixtureBrowserLauncher() })
const fixture = startBrowserFixtureServer()
const db = kernel.db as Database
const now = Date.now()
// This disposable fixture is initialized before test traffic starts.
db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES(?,?,'codex',?,?,?)").run(
  "browser-demo",
  "Pesquisa",
  root,
  now,
  now,
)
db.query("INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES(?,?,'main',?,?,?)").run(
  "browser-thread",
  "browser-demo",
  "Viagem fictícia",
  now,
  now,
)
let scenario = "selected"
let requestCount = 0
await init(kernel, undefined, {
  engine,
  getDecisionApiKey: async () => (scenario === "missing_key" ? null : "synthetic-decision-key"),
  fetchDecision: async (_url, init) => {
    requestCount += 1
    if (scenario === "no_credit") return new Response("synthetic-decision-key upstream detail", { status: 402 })
    if (scenario === "unavailable") throw new Error("synthetic-decision-key provider detail")
    const body = JSON.parse(String(init.body)) as {
      state: { intent: string; candidates: Array<{ ref: string; name: string }> }
    }
    const candidates = body.state.candidates
    const chosen = candidates.find((candidate) =>
      ["Destination primary", "Cabin outbound", "Lisboa, Portugal", "Departure date October 24"].includes(
        candidate.name,
      ),
    )
    const probability = scenario === "ask" ? 0.5 : 0.97
    return Response.json({
      answers: {
        target: {
          type: "choice",
          choice: chosen?.ref ?? "none",
          confidence: probability,
          probabilities: Object.fromEntries([
            ...candidates.map((candidate) => [
              candidate.ref,
              candidate === chosen ? probability : (0.99 - probability) / Math.max(1, candidates.length - 1),
            ]),
            ["none", 0.01],
          ]),
        },
      },
    })
  },
})
const ctx = {
  botId: "browser-demo",
  threadId: "browser-thread",
  runId: "demo-run",
  projectId: null,
  cwd: root,
  signal: new AbortController().signal,
}
let tabId = ""
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.headers.get("Authorization") !== `Bearer ${process.env.TOURI_DECISION_TEST_TOKEN}`)
      return new Response("Unauthorized", { status: 401 })
    const { step, mode } = (await request.json()) as { step: string; mode?: string }
    if (mode) scenario = mode
    if (step === "open") {
      if (tabId) await engine.close({ tabId, botId: ctx.botId, signal: ctx.signal })
      requestCount = 0
      const opened = await engine.open({ url: `http://127.0.0.1:${fixture.port}/travel-search`, ctx, timeoutMs: 10000 })
      if (!opened.success) return Response.json(opened, { status: 500 })
      tabId = (opened.structured as BrowserSnapshot).tabId
      return Response.json({ tabId })
    }
    const commands: Record<string, { tool: string; args: Record<string, unknown> }> = {
      destination: {
        tool: "browser_type",
        args: { target: { kind: "role", role: "textbox", name: "Destination" }, text: "Lisboa" },
      },
      exact: {
        tool: "browser_type",
        args: { target: { kind: "css", selector: "#destination-primary" }, text: "Lisboa" },
      },
      option: { tool: "browser_click", args: { target: { kind: "role", role: "option", name: "Lisboa" } } },
      cabin: {
        tool: "browser_select_option",
        args: { target: { kind: "role", role: "combobox", name: "Cabin" }, values: ["business"] },
      },
      calendar: { tool: "browser_click", args: { target: { kind: "css", selector: "#calendar-open" } } },
      date: { tool: "browser_click", args: { target: { kind: "role", role: "button", name: "Departure date" } } },
      submit: { tool: "browser_click", args: { target: { kind: "css", selector: "#search > span" } } },
      "keyboard-enter": { tool: "browser_press", args: { key: "Enter" } },
      "keyboard-space": { tool: "browser_press", args: { key: " " } },
      sensitive: { tool: "browser_click", args: { target: { kind: "css", selector: "#calendar-open > span" } } },
    }
    if (step === "sensitive")
      await engine.evaluate({
        tabId,
        botId: ctx.botId,
        expression: "document.querySelector('#calendar-open').setAttribute('aria-label', 'Aceitar cookies')",
        signal: ctx.signal,
        timeoutMs: 5000,
      })
    if (step.startsWith("keyboard-"))
      await engine.evaluate({
        tabId,
        botId: ctx.botId,
        expression: "document.querySelector('#calendar-open').focus()",
        signal: ctx.signal,
        timeoutMs: 5000,
      })
    const command = commands[step]
    if (!command) return new Response("Unknown step", { status: 400 })
    const result = await handlers.get(command.tool)?.handler({ ctx, args: { tabId, ...command.args } })
    const page = await engine.snapshot({
      tabId,
      botId: ctx.botId,
      image: "always",
      signal: ctx.signal,
      timeoutMs: 5000,
    })
    const snapshot = page.success ? (page.structured as BrowserSnapshot) : null
    return Response.json({
      result,
      requestCount,
      snapshot,
      part: {
        type: "tool_call",
        callId: step,
        tool: `mcp__touri__${command.tool}`,
        inputJson: JSON.stringify(command.args),
        outputJson: JSON.stringify({
          content: result?.success
            ? (result.content ?? [])
            : [{ type: "text", text: `ERROR ${result?.errorCode}: ${result?.error}` }],
          ...(result?.structured ? { structured: result.structured } : {}),
        }),
        ok: result?.success ?? false,
      },
    })
  },
})
const stop = async () => {
  server.stop(true)
  fixture.stop(true)
  await engine.shutdown()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => {
  void stop()
})
console.log(`DECISION_FIXTURE:${server.port}`)
