import type { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserSnapshot, BrowserTabInfo, BrowserTakeoverInput, ToolRegistration } from "@touri/contracts"
import { init } from "../../../sidecar/src/browser"
import { createBrowserEngine } from "../../../sidecar/src/browser/engine"
import { createHeadlessHost } from "../../../sidecar/src/cli/host/headlessHost"
import { createSecretStore } from "../../../sidecar/src/cli/host/secretStore"
import { createKernel } from "../../../sidecar/src/kernel"

const root = await mkdtemp(join(tmpdir(), "touri-browser-flow-"))
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
const engine = createBrowserEngine({ kernel })
const fixtureUrl = process.env.TOURI_BROWSER_FLOW_FIXTURE_URL
if (!fixtureUrl) throw new Error("The local travel fixture URL is missing.")

const db = kernel.db as Database
const now = Date.now()
db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES(?,?,'codex',?,?,?)").run(
  "browser-demo",
  "Lia",
  root,
  now,
  now,
)
db.query("INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES(?,?,'main',?,?,?)").run(
  "browser-thread",
  "browser-demo",
  "Busca de viagem fictícia",
  now,
  now,
)

const ctx = {
  botId: "browser-demo",
  threadId: "browser-thread",
  runId: "browser-flow-run",
  projectId: null,
  cwd: root,
  signal: new AbortController().signal,
}
let decisionCount = 0
let takeoverInputCount = 0
let resumedPrivateDocumentHidden = false
await init(kernel, undefined, {
  engine,
  getDecisionApiKey: async () => "synthetic-decision-key",
  fetchDecision: async (_url, request) => {
    decisionCount += 1
    const body = JSON.parse(String(request.body)) as {
      state: { candidates: Array<{ ref: string; name: string }> }
    }
    const preferences = ["Destination primary", "Cabin outbound", "Lisboa, Portugal", "October 24"]
    const chosen = preferences.flatMap((name) =>
      body.state.candidates.filter((candidate) => candidate.name.includes(name)),
    )[0]
    const candidates = body.state.candidates
    const confidence = 0.97

    return Response.json({
      answers: {
        target: {
          type: "choice",
          choice: chosen?.ref ?? "none",
          confidence,
          probabilities: Object.fromEntries([
            ...candidates.map((candidate) => [
              candidate.ref,
              candidate === chosen ? confidence : (1 - confidence - 0.01) / Math.max(1, candidates.length - 1),
            ]),
            ["none", 0.01],
          ]),
        },
      },
    })
  },
})

let tabId = ""
let finalImage = ""
const failedSteps: string[] = []
const commands: Record<string, { tool: string; args: Record<string, unknown> }> = {
  open: { tool: "browser_open", args: { url: fixtureUrl } },
  resume: { tool: "browser_open", args: { url: fixtureUrl } },
  read: { tool: "browser_snapshot", args: {} },
  destination: {
    tool: "browser_type",
    args: { target: { kind: "role", role: "textbox", name: "Destination" }, text: "Lisboa" },
  },
  option: {
    tool: "browser_click",
    args: { target: { kind: "role", role: "option", name: "Lisboa" } },
  },
  cabin: {
    tool: "browser_select_option",
    args: { target: { kind: "role", role: "combobox", name: "Cabin" }, values: ["business"] },
  },
  calendar: { tool: "browser_click", args: { target: { kind: "css", selector: "#calendar-open" } } },
  date: {
    tool: "browser_click",
    args: { target: { kind: "role", role: "button", name: "Departure date" } },
  },
  search: { tool: "browser_click", args: { target: { kind: "role", role: "button", name: "Search trips" } } },
  wait: { tool: "browser_wait_for", args: { condition: { text: "Two ways to get there" }, timeoutMs: 5000 } },
  tabs: { tool: "browser_list_tabs", args: {} },
  screenshot: { tool: "browser_screenshot", args: {} },
}

const getSnapshot = async (): Promise<BrowserSnapshot | null> => {
  if (!tabId) return null
  const result = await engine.snapshot({
    tabId,
    botId: ctx.botId,
    image: "always",
    signal: ctx.signal,
    timeoutMs: 8000,
  })

  return result.success ? (result.structured as BrowserSnapshot) : null
}

const getTab = (): (BrowserTabInfo & { ownerBotId: string | null }) | null =>
  engine.tabsForBot(ctx.botId).find((tab) => tab.tabId === tabId) ?? null

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    if (request.headers.get("Authorization") !== `Bearer ${process.env.TOURI_BROWSER_FLOW_TOKEN}`)
      return new Response("Unauthorized", { status: 401 })
    const {
      step,
      tabId: requestedTabId,
      input,
      viewEpoch,
    } = (await request.json()) as {
      step: string
      tabId?: string
      input?: BrowserTakeoverInput
      viewEpoch?: number
    }
    const takeoverTabId = requestedTabId ?? tabId
    if (step === "metadata") {
      const tab = await getTab()
      return Response.json({ tabs: tab ? [tab] : [] })
    }
    if (step === "stats")
      return Response.json({ decisionCount, failedSteps, takeoverInputCount, resumedPrivateDocumentHidden })
    if (step === "preview" || step === "attachment") {
      const snapshot = await getSnapshot()
      return Response.json({
        image: step === "attachment" ? finalImage : (snapshot?.image?.dataUrl ?? ""),
        title: snapshot?.title ?? "",
        url: snapshot?.url ?? "",
      })
    }
    if (step === "takeover-session") {
      const held = await engine.holdTakeover({ tabId: takeoverTabId, reason: "The user requested browser takeover" })
      return held
        ? Response.json({ sessionId: "browser-flow-session", controlEpoch: "browser-flow-control", viewEpoch: 0 })
        : Response.json({ error: "The browser could not be paused." }, { status: 409 })
    }
    if (step === "takeover-frame") {
      const frame = await engine.takeoverFrame({ tabId: takeoverTabId, botId: ctx.botId, signal: ctx.signal })
      return frame
        ? Response.json(Object.assign({}, frame, { controlEpoch: "browser-flow-control", viewEpoch: viewEpoch ?? 0 }))
        : Response.json({ error: "The browser frame is unavailable." }, { status: 409 })
    }
    if (step === "takeover-input") {
      if (!input) return Response.json({ error: "The browser input is missing." }, { status: 400 })
      const sent = await engine.takeoverInput({ tabId: takeoverTabId, botId: ctx.botId, input, signal: ctx.signal })
      if (!sent) return Response.json({ error: "The browser did not receive the input." }, { status: 409 })
      takeoverInputCount += 1
      return Response.json({})
    }
    if (step === "takeover-release") {
      await engine.releaseTakeover(takeoverTabId)
      return Response.json({})
    }
    if (step === "open") {
      if (tabId) await engine.close({ tabId, botId: ctx.botId, signal: ctx.signal })
      decisionCount = 0
      takeoverInputCount = 0
      resumedPrivateDocumentHidden = false
      failedSteps.length = 0
      const result = await engine.open({ url: fixtureUrl, ctx, timeoutMs: 60_000 })
      if (!result.success) return Response.json({ error: result.error }, { status: 500 })
      tabId = (result.structured as BrowserSnapshot).tabId
      return Response.json({
        part: {
          type: "tool_call",
          callId: "browser-flow-open",
          tool: "mcp__touri__browser_open",
          summary: "browser_open",
          inputJson: JSON.stringify({ url: fixtureUrl }),
          outputJson: JSON.stringify({ structured: { tabId } }),
          ok: true,
        },
      })
    }
    const command = commands[step]
    if (!command) return new Response("Unknown browser step", { status: 400 })

    if (step === "resume") {
      const privateSnapshot = await getSnapshot()
      resumedPrivateDocumentHidden = Boolean(
        privateSnapshot &&
          privateSnapshot.url === "" &&
          privateSnapshot.title === "" &&
          privateSnapshot.text === "" &&
          privateSnapshot.image === null &&
          privateSnapshot.elements.every((element) => element.name === "" && element.value === undefined),
      )
      if (!resumedPrivateDocumentHidden)
        return Response.json({ error: "The human-controlled document was not protected." }, { status: 500 })
    }

    const startedAt = Date.now()
    const result = await handlers.get(command.tool)?.handler({ ctx, args: { tabId, ...command.args } })
    const resolvedAt = Date.now()
    if (!result) return new Response("Browser tool is unavailable", { status: 500 })
    if (!result.success) failedSteps.push(`${step}:${result.errorCode}`)
    if (result.success && command.tool === "browser_open") tabId = (result.structured as BrowserSnapshot).tabId
    const snapshot = await getSnapshot()
    if (step === "screenshot") finalImage = snapshot?.image?.dataUrl ?? ""
    const content = result.success ? [] : (result.content ?? [])
    const part = {
      type: "tool_call",
      callId: `browser-flow-${step}`,
      tool: `mcp__touri__${command.tool}`,
      summary: command.tool,
      inputJson: JSON.stringify(Object.assign({}, command.args, { tabId })),
      outputJson: JSON.stringify({
        content,
        ...(command.tool === "browser_open" ? { structured: { tabId } } : {}),
      }),
      ...(step === "screenshot" && finalImage
        ? { outputAttachmentId: "browser-flow-final-screenshot", outputBytes: Math.floor((finalImage.length * 3) / 4) }
        : {}),
      startedAt,
      resolvedAt,
      ok: result.success,
    }

    return Response.json({ part })
  },
})

const stop = async () => {
  server.stop(true)
  await engine.shutdown()
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGTERM", () => void stop())
console.log(`BROWSER_ACTIVITY_FIXTURE:${server.port}`)
