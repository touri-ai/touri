import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderEvent, ProviderSession, StartTurnArgs, Thread } from "@touri/contracts"
import { createServices } from "../../src/kernel/services"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { codexAccessParams } from "../../src/runtime/codex/config"
import { localFolderProfile } from "../../src/runtime/folder-access"
import { withLocalTurnTemp } from "../../src/runtime/local-turn-temp"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const fixture = (provider: "codex" | "claude" = "codex", scenarios: Array<Record<string, unknown>> = [{}]) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-local-sandbox-")))
  const appData = join(root, "data")
  const runDir = join(appData, "run")
  const workspace = join(root, "workspace")
  for (const path of [runDir, workspace]) mkdirSync(path, { recursive: true })
  const calls: Array<Parameters<Kernel["spawnTree"]>[0]> = []
  const events: ProviderEvent[] = []
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const kernel = {
    paths: { appData, runDir },
    services: createServices(),
    redact: (text: string) => text,
    addRedactionValue: () => {},
    newId: () => "approval-sandbox",
    log: () => {},
    spawnTree: (input: Parameters<Kernel["spawnTree"]>[0]) => {
      const scenario = scenarios[Math.min(calls.length, scenarios.length - 1)] ?? {}
      calls.push(input)
      const temporary = input.env.TMPDIR
      if (temporary?.startsWith(runDir)) {
        expect(statSync(temporary).mode & 0o777).toBe(0o700)
        writeFileSync(join(temporary, "probe"), "writable")
      }
      if (typeof scenario.spawnError === "string")
        return { success: false, errorCode: "SPAWN_FAILED", error: scenario.spawnError }
      let output: ReadableStreamDefaultController<Uint8Array>
      const stdout = new ReadableStream<Uint8Array>({
        start: (controller) => {
          output = controller
        },
      })
      let diagnostics: ReadableStreamDefaultController<Uint8Array>
      const stderr = new ReadableStream<Uint8Array>({
        start: (controller) => {
          diagnostics = controller
        },
      })
      const emit = (frame: unknown) => output.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`))
      if (typeof scenario.startupStderr === "string") {
        const diagnostic = scenario.startupStderr
        queueMicrotask(() => diagnostics.enqueue(new TextEncoder().encode(diagnostic)))
      }
      let finish: (value: { code: number; signal: null }) => void = () => {}
      const exited = new Promise<{ code: number; signal: null }>((resolve) => {
        finish = resolve
      })
      let stopped = false
      const complete = () =>
        emit(
          provider === "codex"
            ? { method: "turn/completed", params: { status: "succeeded" } }
            : { type: "result", subtype: "success", session_id: "session-sandbox" },
        )
      return {
        success: true,
        target: "remote",
        pid: 0,
        pgid: 0,
        extra: [],
        stdout,
        stderr,
        exited,
        kill: () => {
          if (stopped) return
          stopped = true
          output.close()
          diagnostics.close()
          finish({ code: 0, signal: null })
        },
        stdin: new WritableStream<Uint8Array>({
          write: (chunk) => {
            const frame = JSON.parse(new TextDecoder().decode(chunk))
            if (stopped) return
            requests.push(frame)
            if (provider === "claude") {
              emit({ type: "system", subtype: "init", session_id: "session-sandbox" })
              complete()
            } else if (frame.method === "initialize") emit({ id: frame.id, result: {} })
            else if (frame.method === "thread/start" || frame.method === "thread/resume")
              emit({ id: frame.id, result: { thread: { id: "session-sandbox" } } })
            else if (frame.method === "turn/start") {
              emit({ id: frame.id, result: {} })
              emit({ method: "turn/started", params: { turnId: "turn-sandbox" } })
              for (const event of (scenario.events ?? [{ type: "complete" }]) as Array<Record<string, unknown>>) {
                if (event.type === "complete") complete()
                else if (event.type === "fail")
                  emit({ method: "turn/completed", params: { status: "failed", errorMessage: event.message } })
                else if (event.type === "command")
                  emit({
                    method: "item/completed",
                    params: {
                      item: { type: "commandExecution", exitCode: event.exitCode, output: event.output ?? "" },
                    },
                  })
                else emit(event)
              }
            } else if (frame.id === 99) complete()
          },
        }),
      }
    },
  } as unknown as Kernel
  const adapter = (provider === "codex" ? createCodexAdapter : createClaudeAdapter)({
    kernel,
    command: process.execPath,
  })
  const args: StartTurnArgs = {
    bot: { access: "workspace-write", approvals: "on-request", homeDir: workspace } as Bot,
    thread: { id: "thread-sandbox" } as Thread,
    session: null,
    fingerprint: { cwd: workspace } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "Save a text file." }],
    developerInstructions: "Test local sandbox.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: {
      HOME: workspace,
      TOURI_RUN_DIR: runDir,
      TMPDIR: "/unwritable-temp",
      TMP: "/unwritable-temp",
      TEMP: "/unwritable-temp",
    },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  }
  cleanups.push(async () => {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runDir, workspace, kernel, adapter, args, calls, events, requests }
}

for (const provider of ["codex", "claude"] as const) {
  for (const resumed of [false, true]) {
    test(`${provider} gives each local ${resumed ? "resumed" : "new"} turn private writable temporary storage`, async () => {
      const f = fixture(provider)
      if (resumed) f.args.session = { externalSessionId: "existing-session", rolloutPath: null } as ProviderSession
      expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
      const env = f.calls[0]?.env
      const temporary = env?.TMPDIR ?? ""
      expect(temporary.startsWith(`${f.runDir}/`)).toBe(true)
      expect(env).toMatchObject({ TMPDIR: temporary, TMP: temporary, TEMP: temporary })
      const profile = localFolderProfile(f.kernel, f.args, env ?? {}, f.workspace)
      expect(profile).toContain(`(subpath ${JSON.stringify(temporary)})`)
      expect(profile).toContain(`(require-not (subpath ${JSON.stringify(temporary)}))`)
      if (provider === "codex") {
        const session = f.requests.find((request) => request.method === (resumed ? "thread/resume" : "thread/start"))
        expect(session).toMatchObject({
          params: {
            config: {
              sandbox_workspace_write: { writable_roots: expect.arrayContaining([temporary]) },
              shell_environment_policy: { set: { TMPDIR: temporary, TMP: temporary, TEMP: temporary } },
            },
          },
        })
      } else expect(f.calls[0]?.args).toContain(temporary)
      expect(existsSync(temporary)).toBe(false)
      expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
      expect(f.calls[1]?.env.TMPDIR).not.toBe(temporary)
      expect(f.args.env.TMPDIR).toBe("/unwritable-temp")
    })
  }
}

test("Codex retries sandbox startup once before forwarding an escalation approval", async () => {
  const f = fixture("codex", [
    {
      events: [
        {
          id: 99,
          method: "item/commandExecution/requestApproval",
          params: { reason: "Sandbox failed to start", command: "save file" },
        },
      ],
    },
    { events: [{ type: "complete" }] },
  ])
  f.args.onEvent = (event) => {
    f.events.push(event)
    if (event.type === "approval_request")
      void f.adapter.answerApproval({ approvalId: event.approvalId, decision: "denied" })
  }
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
  expect(f.calls).toHaveLength(2)
  expect(f.calls[1]?.env.TMPDIR).not.toBe(f.calls[0]?.env.TMPDIR)
  expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(0)
})

for (const scenario of [
  { spawnError: "sandbox-exec: sandbox_apply: Operation not permitted" },
  { startupStderr: "sandbox-exec: sandbox_init: Operation not permitted", events: [] },
  { events: [{ type: "command", exitCode: 1, output: "Sandbox failed to start" }] },
  { events: [{ type: "fail", message: "Failed to initialize sandbox" }] },
  { events: [{ method: "error", params: { message: "Sandbox initialization failed" } }] },
]) {
  test(`Codex recovers a sandbox startup failure: ${JSON.stringify(scenario)}`, async () => {
    const f = fixture("codex", [scenario, {}])
    expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
    expect(f.calls).toHaveLength(2)
    expect(f.events.filter((event) => event.type === "turn_completed")).toHaveLength(1)
    for (const call of f.calls) expect(existsSync(call.env.TMPDIR ?? "")).toBe(false)
  })
}

test("Codex forwards the approval if sandbox recovery also fails", async () => {
  const f = fixture("codex", [
    {
      events: [
        { id: 99, method: "item/commandExecution/requestApproval", params: { reason: "Sandbox failed to start" } },
      ],
    },
  ])
  f.args.onEvent = (event) => {
    f.events.push(event)
    if (event.type === "approval_request")
      void f.adapter.answerApproval({ approvalId: event.approvalId, decision: "denied" })
  }
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
  expect(f.calls).toHaveLength(2)
  expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1)
})

test("Codex does not retry canceled turns or ordinary permission errors", async () => {
  for (const canceled of [false, true]) {
    const f = fixture("codex", [
      { events: [{ type: "fail", message: canceled ? "Sandbox failed to start" : "Permission denied" }] },
    ])
    if (canceled) {
      const controller = new AbortController()
      f.args.signal = controller.signal
      f.args.onEvent = (event) => {
        if (event.type === "turn_started") controller.abort()
      }
    }
    expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "failed" })
    expect(f.calls).toHaveLength(1)
  }
})

test("VM turns keep their guest temp environment and do not allocate host temporary storage", async () => {
  const f = fixture()
  f.args.execution = { spawn: f.kernel.spawnTree, writeFile: async () => {} }
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "succeeded" })
  expect(f.calls[0]?.env.TMPDIR).toBe("/unwritable-temp")
  expect(existsSync(join(f.runDir, "provider-tmp"))).toBe(false)
})

test.skipIf(process.platform !== "darwin")(
  "macOS permits a heredoc in private temp and a write in an approved folder",
  async () => {
    const f = fixture()
    const approved = join(f.root, "approved")
    mkdirSync(approved)
    f.args.bot.folders = [{ path: approved, access: "read-write" }]
    await withLocalTurnTemp(f.kernel, f.args, async (args) => {
      const profile = localFolderProfile(f.kernel, args, args.env, f.workspace)
      const result = Bun.spawnSync({
        cmd: [
          "/usr/bin/sandbox-exec",
          "-p",
          profile,
          "/bin/zsh",
          "-c",
          "cat <<'TEXT' > \"$1\"\nhello\nTEXT",
          "test",
          join(approved, "saved.txt"),
        ],
        cwd: f.workspace,
        env: args.env,
      })
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(approved, "saved.txt"))).toBe(true)
    })
  },
)

test("Codex does not replay a tool action when a later sandbox fails to start", async () => {
  const f = fixture("codex", [
    {
      events: [
        { type: "command", exitCode: 0 },
        { type: "fail", message: "Sandbox failed to start" },
      ],
    },
  ])
  expect(await f.adapter.startTurn(f.args)).toMatchObject({ success: true, status: "failed" })
  expect(f.calls).toHaveLength(1)
})

test("Codex makes approved read-write folders and private temp writable without granting read-only folders", async () => {
  const f = fixture()
  const writable = join(f.root, "approved")
  const reference = join(f.root, "reference")
  for (const path of [writable, reference]) mkdirSync(path)
  f.args.bot.folders = [
    { path: writable, access: "read-write" },
    { path: reference, access: "read-only" },
  ]
  await withLocalTurnTemp(f.kernel, f.args, async (args) => {
    const config = codexAccessParams(args).config as { sandbox_workspace_write: { writable_roots: string[] } }
    expect(config.sandbox_workspace_write.writable_roots).toEqual(
      expect.arrayContaining([f.workspace, writable, args.env.TMPDIR]),
    )
    expect(config.sandbox_workspace_write.writable_roots).not.toContain(reference)
    const profile = localFolderProfile(f.kernel, args, args.env, f.workspace)
    expect(profile).toContain(`(subpath ${JSON.stringify(writable)})`)
    expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(reference)}))`)
  })
})
