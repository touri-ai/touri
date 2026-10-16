import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderEvent, ProviderSession, StartTurnArgs, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createOpenCodeAdapter } from "../../src/runtime/opencode/adapter"
import { fullAccess, openCodePermissions, providerSecretEnv } from "../../src/runtime/opencode/config"
import { openCodeEvents, readOpenCodeSse } from "../../src/runtime/opencode/events"
import { writePrivateFile } from "../../src/runtime/utils"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const fixture = (scenario: Record<string, unknown> = {}, vm = false) => {
  const root = mkdtempSync(join(tmpdir(), "touri-opencode-test-"))
  const runtime = createKernel({ appData: join(root, "data") })
  const home = join(root, "user")
  mkdirSync(home)
  const scenarioPath = join(root, "scenario.json")
  const recordPath = join(root, "record.jsonl")
  writeFileSync(scenarioPath, JSON.stringify(scenario))
  const calls: Array<Parameters<Kernel["spawnTree"]>[0]> = []
  const spawn: Kernel["spawnTree"] = (input) => {
    calls.push(input)
    if (input.cmd === "cat") return runtime.kernel.spawnTree({ ...input, cmd: "/bin/cat" })
    return runtime.kernel.spawnTree({
      ...input,
      cmd: process.execPath,
      args: [
        "run",
        join(import.meta.dir, "../fakes/fake-opencode.ts"),
        ...(input.cmd === "/usr/bin/sandbox-exec" ? input.args.slice(3) : input.args),
      ],
    })
  }
  const kernel = { ...runtime.kernel, spawnTree: spawn }
  const adapter = createOpenCodeAdapter({ kernel, command: process.execPath, startupMs: 2000, interruptGraceMs: 50 })
  const events: ProviderEvent[] = []
  const controller = new AbortController()
  const args: StartTurnArgs = {
    bot: {
      id: "b",
      provider: "opencode",
      homeDir: join(runtime.kernel.paths.botsDir, "b"),
      projectId: null,
      access: "workspace-write",
      approvals: "on-request",
      model: null,
      reasoningEffort: null,
    } as Bot,
    thread: { id: "thread", title: "Conversa" } as Thread,
    session: null,
    fingerprint: { cwd: root } as StartTurnArgs["fingerprint"],
    developerInstructions: "Responda em português",
    handoffPacket: null,
    input: [{ type: "text", text: "Leia o arquivo" }],
    mcp: { command: "/fake/mcp", args: [], env: { MCP_TOKEN: "private-token" } },
    env: { HOME: home, TOURI_OPENCODE_SCENARIO: scenarioPath, TOURI_OPENCODE_RECORD: recordPath },
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    ...(vm
      ? {
          execution: {
            spawn,
            writeFile: async (file) => writePrivateFile({ root, ...file }),
            connect: async (port) => `http://127.0.0.1:${port}`,
          },
        }
      : {}),
  }
  cleanups.push(async () => {
    await adapter.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    runtime,
    adapter,
    args,
    events,
    calls,
    controller,
    records: () =>
      readFileSync(recordPath, "utf8")
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s)),
  }
}

for (const vm of [false, true])
  test(`OpenCode streams text/reasoning/tools/usage and resumes on ${vm ? "VM" : "host"}`, async () => {
    const f = fixture({}, vm)
    const first = await f.adapter.startTurn(f.args)
    expect(first).toMatchObject({ success: true, externalSessionId: "ses_fake", status: "succeeded" })
    expect(f.events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", itemId: "text", delta: "Olá, ação concluída." },
    ])
    expect(f.events).toContainEqual({ type: "reasoning_delta", itemId: "reason", delta: "Vou conferir." })
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "item",
        part: expect.objectContaining({ type: "tool_call", summary: "OpenCode · Ler arquivo", ok: true }),
      }),
    )
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "usage",
        usage: expect.objectContaining({ inputTokens: 12, outputTokens: 6, costUsd: 0.002, cachedInputTokens: 3 }),
      }),
    )
    f.args.session = { externalSessionId: "ses_fake" } as ProviderSession
    expect((await f.adapter.startTurn(f.args)).success).toBe(true)
    const records = f.records()
    expect(records.filter((r) => r.path === "/session")).toHaveLength(1)
    expect(records.some((r) => r.path === "/session/ses_fake")).toBe(true)
    const prompt = records.find((r) => r.path?.endsWith("/prompt_async"))
    expect(prompt.body.messageID).toBeUndefined()
    expect(prompt.body.model).toEqual({ providerID: "openrouter", modelID: "deepseek/deepseek-v3.2" })
    const spawned = records.find((r) => r.type === "spawn")
    expect(spawned.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
    expect(spawned.env.OPENCODE_CONFIG_DIR).toStartWith(`${f.root}/`)
    expect(spawned.env.DO_NOT_TRACK).toBe("1")
    expect(spawned.env.OTEL_SDK_DISABLED).toBe("true")
    expect(spawned.config.mcp.touri.command).toEqual(["/fake/mcp"])
    expect(spawned.config.permission.bash).toBeUndefined()
    expect(spawned.config.permission["*"]).toBe("ask")
  })

for (const [access, approvals, reply, card] of [
  ["read-only", "on-request", "reject", false],
  ["read-only", "never", "reject", false],
  ["workspace-write", "on-request", "once", true],
  ["workspace-write", "never", "once", true],
  ["full", "on-request", "once", true],
  ["full", "never", "once", false],
] as const)
  test(`OpenCode permission ${access}/${approvals} requires the correct decision`, async () => {
    const f = fixture({ permission: true })
    f.args.bot.access = access
    f.args.bot.approvals = approvals
    f.args.onEvent = (event) => {
      f.events.push(event)
      if (event.type === "approval_request") {
        expect(event.part.scope).toEqual({ source: "opencode", tool: "bash" })
        expect(event.part.allowStanding).toBe(false)
        void f.adapter.answerApproval({ approvalId: event.approvalId, decision: "approved" })
      }
    }
    expect((await f.adapter.startTurn(f.args)).success).toBe(true)
    expect(f.events.some((event) => event.type === "approval_request")).toBe(card)
    expect(f.records().find((r) => r.path === "/permission/per_fake/reply").body.reply).toBe(reply)
    expect(openCodePermissions(f.args.bot)["*"]).toBe(
      fullAccess(f.args.bot) ? "allow" : access === "read-only" ? "deny" : "ask",
    )
  })

test("denial sends reject, cancellation interrupts and late approvals are fenced", async () => {
  const f = fixture({ permission: true, hold: true })
  let approvalId = ""
  f.args.onEvent = (event) => {
    if (event.type === "approval_request") {
      approvalId = event.approvalId
      void f.adapter.answerApproval({ approvalId, decision: "denied" }).then(() => f.controller.abort())
    }
  }
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "interrupted" })
  expect(f.records().find((r) => r.path === "/permission/per_fake/reply").body.reply).toBe("reject")
  expect(await f.adapter.answerApproval({ approvalId, decision: "approved" })).toMatchObject({
    success: false,
    errorCode: "NOT_FOUND",
  })
})

test.each([{ hostile: true }, { mcpFailed: true }])(
  "OpenCode blocks unsafe effective settings or missing touri MCP: %j",
  async (scenario) => {
    const f = fixture(scenario)
    expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: false, errorCode: "cli_protocol" })
    expect(f.records().some((r) => r.path?.endsWith("/prompt_async"))).toBe(false)
  },
)

test("malformed SSE and vanished resume sessions produce protocol errors", async () => {
  const f = fixture({ malformed: true })
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: false, errorCode: "cli_protocol" })
  const missing = fixture({ missingSession: true })
  missing.args.session = { externalSessionId: "ses_gone" } as ProviderSession
  expect(await missing.adapter.startTurn(missing.args)).toMatchObject({ success: false, errorCode: "cli_protocol" })
  expect(missing.events.some((event) => event.type === "turn_started")).toBe(false)
})

test("SSE decoder handles CRLF/chunks and rejects a truncated frame", async () => {
  const values: unknown[] = []
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"texto":"ação"}\r\n\r\n')
  await readOpenCodeSse(
    new ReadableStream({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte))
        c.close()
      },
    }),
    (value) => values.push(value),
  )
  expect(values).toEqual([{ texto: "ação" }])
  await expect(
    readOpenCodeSse(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"type":'))
          c.close()
        },
      }),
      () => {},
    ),
  ).rejects.toThrow("incompleto")
})

test("session.next events preserve reasoning, text, tool results, coded auth errors and isolate sessions", () => {
  const events: ProviderEvent[] = []
  const translate = openCodeEvents("ses", (event) => events.push(event))
  translate({
    type: "session.next.reasoning.delta",
    properties: { sessionID: "ses", reasoningID: "r", delta: "Pensando" },
  })
  translate({
    type: "session.next.text.delta",
    properties: { sessionID: "other", textID: "t", delta: "Outra conversa" },
  })
  translate({ type: "session.next.text.delta", properties: { sessionID: "ses", textID: "t", delta: "Pronto" } })
  translate({
    type: "session.next.tool.called",
    properties: {
      sessionID: "ses",
      callID: "c",
      tool: "touri_browser_navigate",
      input: { url: "https://example.com" },
    },
  })
  translate({ type: "session.next.tool.success", properties: { sessionID: "ses", callID: "c", result: "ok" } })
  expect(events.filter((e) => e.type === "text_delta")).toEqual([{ type: "text_delta", itemId: "t", delta: "Pronto" }])
  expect(
    translate({ type: "session.error", properties: { sessionID: "ses", error: { name: "ProviderAuthError" } } })
      .errorCode,
  ).toBe("cli_auth")
})

test("provider secrets reach the CLI with project precedence and redaction", async () => {
  const f = fixture()
  const db = f.runtime.kernel.db as import("bun:sqlite").Database
  db.exec(
    "INSERT INTO secrets(id,name,keychain_account,usage_json,created_at,updated_at) VALUES ('key','OPENROUTER_API_KEY','global/OPENROUTER_API_KEY','{\"env\":true,\"browser\":false}',1,1)",
  )
  const kernel: Kernel = {
    ...f.runtime.kernel,
    callHost: async () => ({ success: true, value: { value: "test-openrouter-key" } }) as never,
  }
  expect(await providerSecretEnv(kernel, { projectId: null })).toEqual({ OPENROUTER_API_KEY: "test-openrouter-key" })
  expect(f.runtime.kernel.redact("test-openrouter-key")).not.toContain("test-openrouter-key")
})

test("R13-B08: delegated secret denial skips project keys and malformed env usage is ignored", async () => {
  const f = fixture()
  const db = f.runtime.kernel.db as import("bun:sqlite").Database
  db.exec("INSERT INTO projects(id,name,path,data_dir,created_at,updated_at) VALUES ('p','t','/tmp/p','/tmp/pd',1,1)")
  db.exec(
    "INSERT INTO secrets(id,project_id,name,keychain_account,usage_json,created_at,updated_at) VALUES ('k1','p','OPENAI_API_KEY','p/OPENAI_API_KEY','{\"env\":true}',1,1)",
  )
  db.exec(
    "INSERT INTO secrets(id,name,keychain_account,usage_json,created_at,updated_at) VALUES ('k2','GROQ_API_KEY','global/GROQ_API_KEY','{\"env\":\"yes\"}',1,1)",
  )
  const kernel: Kernel = {
    ...f.runtime.kernel,
    callHost: async () => ({ success: true, value: { value: "test-provider-key" } }) as never,
  }
  expect(await providerSecretEnv(kernel, { projectId: "p" })).toEqual({ OPENAI_API_KEY: "test-provider-key" })
  expect(await providerSecretEnv(kernel, { projectId: "p" }, undefined, false)).toEqual({})
})

test("OpenCode copies credentials without importing remote config and clears its copy after the turn", async () => {
  const f = fixture()
  const authDir = join(f.args.env.HOME ?? "", ".local/share/opencode")
  mkdirSync(authDir, { recursive: true })
  const original = JSON.stringify({
    openrouter: { type: "api", key: "host-openrouter-private-key" },
    "https://remote.example": { type: "wellknown", key: "REMOTE", token: "remote-private-key" },
  })
  writeFileSync(join(authDir, "auth.json"), original)
  expect((await f.adapter.startTurn(f.args)).success).toBe(true)
  expect(readFileSync(join(authDir, "auth.json"), "utf8")).toBe(original)
  expect(readFileSync(join(f.args.bot.homeDir, ".touri-opencode/thread/data/opencode/auth.json"), "utf8")).toBe("{}")
  expect(f.runtime.kernel.redact("host-openrouter-private-key")).not.toContain("host-openrouter-private-key")
  expect(f.calls.find((call) => call.args.includes("serve"))?.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
})

test("OpenCode shutdown fences a held run and CLI crashes have a coded reason", async () => {
  const f = fixture({ hold: true })
  const turn = f.adapter.startTurn(f.args)
  const deadline = Date.now() + 3000
  while (!f.events.some((event) => event.type === "turn_started")) {
    if (Date.now() > deadline) throw new Error("Turn did not start")
    await Bun.sleep(5)
  }
  await f.adapter.shutdown()
  expect(await turn).toMatchObject({ success: false, errorCode: "cli_crash" })
  const crashed = fixture({ crash: true })
  expect(await crashed.adapter.startTurn(crashed.args)).toMatchObject({ success: false, errorCode: "cli_crash" })
})

test("OpenCode sends stored image attachments as file parts instead of placeholders", async () => {
  const f = fixture()
  const path = join(f.runtime.kernel.paths.attachmentsDir, "image.png")
  mkdirSync(f.runtime.kernel.paths.attachmentsDir, { recursive: true })
  writeFileSync(path, "fake-png")
  const db = f.runtime.kernel.db as import("bun:sqlite").Database
  db.query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES (?,?,?,8,1)").run("image", path, "image/png")
  f.args.input.push({ type: "image", attachmentId: "image", mime: "image/png" })
  expect((await f.adapter.startTurn(f.args)).success).toBe(true)
  const parts = f.records().find((r) => r.path?.endsWith("/prompt_async")).body.parts
  expect(parts).toContainEqual({
    type: "file",
    mime: "image/png",
    url: `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`,
  })
})

test("OpenCode recognizes v2 permission requests used by 1.18.13", () => {
  const translate = openCodeEvents("s", () => {})
  expect(
    translate({
      type: "permission.v2.asked",
      properties: { sessionID: "s", id: "per", action: "shell.exec", resources: ["printf teste"] },
    }).permission,
  ).toMatchObject({ api: "v2", id: "per", permission: "shell.exec", patterns: ["printf teste"] })
})

test("OpenCode receives explicit folder permissions and an outer sandbox for terminal commands", async () => {
  const f = fixture()
  const { realpathSync } = await import("node:fs")
  const ro = join(f.root, "reference")
  mkdirSync(ro)
  const path = realpathSync(ro)
  f.args.bot.folders = [{ path, access: "read-only" }]
  f.args.bot.anyFolderAccess = true
  expect((await f.adapter.startTurn(f.args)).success).toBe(true)
  const config = f.records().find((record) => record.type === "spawn").config
  expect(config.permission.external_directory).toMatchObject({ [`${path}/**`]: "allow", "/**": "allow" })
  expect(config.permission.edit).toMatchObject({ [`${path}/**`]: "deny" })
  expect(f.calls.some((call) => call.cmd === "/usr/bin/sandbox-exec")).toBe(true)
})
