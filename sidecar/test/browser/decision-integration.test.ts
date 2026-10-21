import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BrowserSnapshot,
  BrowserTakeoverReason,
  BrowserTarget,
  ToolRegistration,
  ToolResult,
} from "@touri/contracts"
import { init } from "../../src/browser"
import { isSafeBrowserRead } from "../../src/browser/decision"
import type { BrowserEngine } from "../../src/browser/types"
import { createKernel } from "../../src/kernel"

const cleanups = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup()
  cleanups.clear()
})

const snapshot: BrowserSnapshot = {
  tabId: "t_00000000000000000000000000",
  generation: 2,
  url: "https://travel.example.test/search",
  title: "Travel search",
  loading: false,
  viewport: { width: 1280, height: 720, scrollY: 0, scrollHeight: 720 },
  focus: { ref: null, role: null, name: null },
  elements: [
    { ref: "2.1", role: "option", name: "Lisboa, Portugal", states: [], frame: "main", inViewport: true },
    { ref: "2.2", role: "option", name: "Lisboa Airport", states: [], frame: "main", inViewport: true },
    { ref: "2.3", role: "option", name: "Lisboa, pessoa@example.com", states: [], frame: "main", inViewport: true },
  ],
  text: "",
  truncated: false,
  recentActions: [],
  diagnostics: [],
  image: null,
  recommendImage: null,
  heldByUser: false,
  notes: [],
}

const result = (success: boolean): ToolResult =>
  success
    ? { success: true, content: [] }
    : { success: false, errorCode: "ENGINE_UNAVAILABLE", error: "Synthetic browser failure" }

const makeEngine = ({
  snapshot: page = snapshot,
}: {
  snapshot?: BrowserSnapshot
} = {}): {
  engine: BrowserEngine
  clicks: () => Array<BrowserTarget>
  takeovers: () => Array<{ tabId: string; botId: string; reason: string; reasonCode?: BrowserTakeoverReason }>
  presses: () => number
  secretSubmissions: () => number
  types: () => number
  evaluations: () => Array<string>
} => {
  let clicks: Array<BrowserTarget> = []
  let takeovers: Array<{ tabId: string; botId: string; reason: string; reasonCode?: BrowserTakeoverReason }> = []
  let presses = 0
  let secretSubmissions = 0
  let types = 0
  let evaluations: Array<string> = []
  const engine: BrowserEngine = {
    preview: async () => null,
    open: async () => result(true),
    list: async () => result(true),
    close: async () => result(true),
    snapshot: async () => ({ success: true, content: [], structured: page }),
    screenshot: async () => result(true),
    navigate: async () => result(true),
    click: async ({ target }) => {
      clicks = [...clicks, target]
      return clicks.length === 1
        ? { success: false, errorCode: "AMBIGUOUS_TARGET", error: "Two targets match." }
        : result(true)
    },
    type: async () => {
      types += 1
      return result(true)
    },
    press: async () => {
      presses += 1
      return result(true)
    },
    hover: async () => result(true),
    scroll: async () => result(true),
    selectOption: async () => result(true),
    setChecked: async () => result(true),
    waitFor: async () => result(true),
    evaluate: async ({ expression }) => {
      evaluations = [...evaluations, expression]
      return result(true)
    },
    requestTakeover: async (input) => {
      takeovers = [...takeovers, input]
      return {
        success: true,
        content: [{ type: "text", text: "Waiting for the person to return control of the browser." }],
        structured: { status: "waiting_for_person" },
      }
    },
    submitSecret: async () => {
      secretSubmissions += 1
      return result(true)
    },
    takeoverFrame: async () => null,
    takeoverInput: async () => false,
    secretEntry: async () => false,
    releaseTakeover: async () => false,
    cancelTakeover: () => false,
    releaseTakeoverForPerson: async () => "not_found",
    holdTakeover: async () => false,
    holdTakeoverForPerson: async () => "not_found",
    getWindowBounds: async () => null,
    tabsForBot: () => [
      {
        tabId: snapshot.tabId,
        ownerBotId: "bot-test",
        title: snapshot.title,
        url: snapshot.url,
        state: "live",
        openerTabId: null,
        heldByUser: false,
        lastUsedAt: Date.now(),
      },
    ],
    shutdown: async () => {},
  }

  return {
    engine,
    clicks: () => clicks,
    takeovers: () => takeovers,
    presses: () => presses,
    secretSubmissions: () => secretSubmissions,
    types: () => types,
    evaluations: () => evaluations,
  }
}

const makeFixture = async ({
  getApiKey,
  fetchDecision,
  pageSnapshot,
}: {
  getApiKey: (signal: AbortSignal) => Promise<string | null>
  fetchDecision: (input: string, init: RequestInit) => Promise<Response>
  pageSnapshot?: BrowserSnapshot
}) => {
  const root = mkdtempSync(join(tmpdir(), "touri-browser-decision-"))
  const runtime = createKernel({ appData: root })
  const handlers = new Map<string, ToolRegistration>()
  const registered = runtime.kernel.registerTools
  runtime.kernel.registerTools = (input) => {
    for (const tool of input.tools) handlers.set(tool.name, tool)
    return registered(input)
  }
  const fake = makeEngine({
    ...(pageSnapshot ? { snapshot: pageSnapshot } : {}),
  })
  await init(runtime.kernel, undefined, {
    engine: fake.engine,
    getDecisionApiKey: getApiKey,
    fetchDecision,
  })

  const context = {
    botId: "bot-test",
    threadId: "thread-test",
    runId: "run-test",
    projectId: null,
    cwd: root,
    signal: new AbortController().signal,
  }

  cleanups.add(async () => {
    await fake.engine.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })

  return {
    context,
    handler: handlers.get("browser_click")?.handler,
    typeHandler: handlers.get("browser_type")?.handler,
    pressHandler: handlers.get("browser_press")?.handler,
    secretHandler: handlers.get("browser_submit_secret")?.handler,
    evaluateHandler: handlers.get("browser_evaluate")?.handler,
    clicks: fake.clicks,
    presses: fake.presses,
    secretSubmissions: fake.secretSubmissions,
    types: fake.types,
    evaluations: fake.evaluations,
    takeovers: fake.takeovers,
  }
}

test("typing into a stale plain search ref asks for a fresh snapshot without takeover", async () => {
  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => Response.json({}),
  })
  const response = await fixture.typeHandler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, target: { kind: "ref", ref: "9.9" }, text: "Lisboa", submit: false },
  })

  expect(response).toMatchObject({ success: false, errorCode: "TARGET_CHANGED" })
  expect(fixture.takeovers()).toEqual([])
  expect(fixture.types()).toBe(0)
})

test("browser script tool limits reads and requests takeover for actions", async () => {
  expect(isSafeBrowserRead('document.querySelector("#results").textContent')).toBe(true)
  expect(isSafeBrowserRead("document.querySelector('#results').textContent")).toBe(true)
  expect(isSafeBrowserRead("document.querySelector('#search').click()")).toBe(false)
  expect(isSafeBrowserRead("document.querySelector('#search')['click']()")).toBe(false)
  expect(isSafeBrowserRead("document.querySelector('#search').form.requestSubmit()")).toBe(false)

  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => Response.json({}),
  })
  const takeover = await fixture.evaluateHandler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, expression: "document.querySelector('#search')['click']()" },
  })
  expect(takeover?.success).toBe(true)
  expect(fixture.evaluations()).toEqual([])
  expect(fixture.takeovers()).toMatchObject([{ reasonCode: "sensitive_action" }])

  const readOnly = await fixture.evaluateHandler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, expression: "document.querySelector('#results').textContent" },
  })
  expect(readOnly?.success).toBe(true)
  expect(fixture.evaluations()).toEqual(["document.querySelector('#results').textContent"])
})

test("an ambiguous safe option is resolved and retried once with a provider-selected ref", async () => {
  let requests: Array<{ url: string; body: string }> = []
  const fixture = await makeFixture({
    getApiKey: async () => "synthetic-test-key",
    fetchDecision: async (input, init) => {
      requests = [...requests, { url: input, body: String(init.body) }]
      return Response.json({
        answers: {
          target: {
            type: "choice",
            choice: "2.2",
            confidence: 0.95,
            probabilities: { "2.1": 0.02, "2.2": 0.97, none: 0.01 },
          },
        },
      })
    },
  })
  const response = await fixture.handler?.({
    ctx: fixture.context,
    args: {
      tabId: snapshot.tabId,
      target: { kind: "role", role: "option", name: "Lisboa, pessoa@example.com" },
    },
  })

  expect(response?.success).toBe(true)
  expect(fixture.clicks()).toEqual([
    { kind: "role", role: "option", name: "Lisboa, pessoa@example.com" },
    { kind: "ref", ref: "2.2" },
  ])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions")
  expect(requests[0]?.body).toContain("Lisboa Airport")
  expect(requests[0]?.body).not.toContain("pessoa@example.com")
  expect(requests[0]?.body).not.toContain("example")
  expect(requests[0]?.body).not.toContain("synthetic-test-key")
})

test("low confidence stops before a retry and makes the user question explicit", async () => {
  const fixture = await makeFixture({
    getApiKey: async () => "synthetic-test-key",
    fetchDecision: async () =>
      Response.json({
        answers: {
          target: {
            type: "choice",
            choice: "2.1",
            confidence: 0.58,
            probabilities: { "2.1": 0.55, "2.2": 0.42, none: 0.03 },
          },
        },
      }),
  })
  const response = await fixture.handler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, target: { kind: "role", role: "option", name: "Lisboa" } },
  })

  expect(fixture.clicks()).toHaveLength(1)
  expect(response).toMatchObject({ success: false, errorCode: "AMBIGUOUS_TARGET" })
  expect(JSON.stringify(response)).toContain("Ask the user which visible option to use")
  expect(JSON.stringify(response)).toContain("Lisboa Airport")
})

test("low confidence questions redact personal text from the requested target", async () => {
  const fixture = await makeFixture({
    getApiKey: async () => "synthetic-test-key",
    fetchDecision: async () =>
      Response.json({
        answers: {
          target: {
            type: "choice",
            choice: "2.1",
            confidence: 0.58,
            probabilities: { "2.1": 0.55, "2.2": 0.42, "2.3": 0.01, none: 0.02 },
          },
        },
      }),
  })
  const response = await fixture.handler?.({
    ctx: fixture.context,
    args: {
      tabId: snapshot.tabId,
      target: { kind: "role", role: "option", name: "Lisboa pessoa@example.com" },
    },
  })

  expect(JSON.stringify(response)).toContain("TOURI_BROWSER_DECISION_QUESTION")
  expect(JSON.stringify(response)).not.toContain("pessoa@example.com")
  expect(JSON.stringify(response)).not.toContain("example")
})

test("missing keys keep the existing browser result and add a localized hint marker", async () => {
  let requests = 0
  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => {
      requests += 1
      return Response.json({})
    },
  })
  const response = await fixture.handler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, target: { kind: "role", role: "option", name: "Lisboa" } },
  })

  expect(response).toMatchObject({ success: false, errorCode: "AMBIGUOUS_TARGET" })
  expect(fixture.clicks()).toHaveLength(1)
  expect(requests).toBe(0)
  expect(JSON.stringify(response)).toContain("TOURI_BROWSER_DECISION_HINT|missing_key")
})

test("sensitive actions return while waiting for the person and do not run", async () => {
  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => Response.json({}),
  })
  const response = await fixture.handler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, target: { kind: "role", role: "button", name: "Buy this ticket" } },
  })

  expect(response).toMatchObject({ success: true, structured: { status: "waiting_for_person" } })
  expect(fixture.clicks()).toHaveLength(0)
  expect(fixture.takeovers()).toMatchObject([
    {
      tabId: snapshot.tabId,
      botId: "bot-test",
      reason: "payment",
      reasonCode: "payment",
    },
  ])
})

test("Enter on a form pauses the run until the person returns control", async () => {
  const pageSnapshot: BrowserSnapshot = {
    ...snapshot,
    focus: { ref: "2.4", role: "textbox", name: "Destination" },
    elements: [
      ...snapshot.elements,
      {
        ref: "2.4",
        role: "textbox",
        name: "Destination",
        states: ["focused"],
        frame: "main",
        inViewport: true,
        formAssociated: true,
      },
    ],
  }
  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => Response.json({}),
    pageSnapshot,
  })

  const response = await fixture.pressHandler?.({
    ctx: fixture.context,
    args: { tabId: snapshot.tabId, key: "NumpadEnter" },
  })

  expect(response?.success).toBe(true)
  expect(fixture.presses()).toBe(0)
  expect(fixture.takeovers()).toMatchObject([
    {
      tabId: snapshot.tabId,
      botId: "bot-test",
      reason: "form_submit",
      reasonCode: "form_submit",
    },
  ])
})

test("credential entry pauses for the person without sending stored secrets to the browser tool", async () => {
  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => Response.json({}),
  })

  const response = await fixture.secretHandler?.({
    ctx: fixture.context,
    args: {
      tabId: snapshot.tabId,
      secretName: "saved-login",
      fields: [{ kind: "password", target: { kind: "role", role: "textbox", name: "Password" } }],
    },
  })

  expect(response?.success).toBe(true)
  expect(fixture.secretSubmissions()).toBe(0)
  expect(fixture.takeovers()).toMatchObject([{ reasonCode: "login" }])
})

test.each(["Enter", "NumpadEnter", " "])("keyboard %s pauses before activating a consent control", async (key) => {
  const pageSnapshot: BrowserSnapshot = {
    ...snapshot,
    focus: { ref: "2.4", role: "button", name: "Aceitar cookies" },
    elements: [
      {
        ref: "2.4",
        role: "button",
        name: "Aceitar cookies",
        states: ["focused"],
        frame: "main",
        inViewport: true,
        formAssociated: false,
      },
    ],
  }
  const fixture = await makeFixture({
    getApiKey: async () => null,
    fetchDecision: async () => Response.json({}),
    pageSnapshot,
  })

  const result = await fixture.pressHandler?.({ ctx: fixture.context, args: { tabId: snapshot.tabId, key } })

  expect(result?.success).toBe(true)
  expect(fixture.presses()).toBe(0)
  expect(fixture.takeovers()).toMatchObject([{ reasonCode: "sensitive_action" }])
})
