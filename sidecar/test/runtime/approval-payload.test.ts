import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Bot, Kernel, ProviderEvent, StartTurnArgs, Thread, ToolContext } from "@touri/contracts"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { createAppPaths } from "../../src/kernel/paths"
import { createRedactor } from "../../src/kernel/redact"
import { createServices } from "../../src/kernel/services"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { createTestStore } from "./fake-store"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

const run = async (provider: "codex" | "claude", frames: unknown[]) => {
  const root = mkdtempSync(join(tmpdir(), "touri-approval-payload-"))
  const redactor = createRedactor()
  redactor.addRedactionValue("registered-fixture-secret")
  const spawn: Kernel["spawnTree"] = () => {
    let output: ReadableStreamDefaultController<Uint8Array>
    let exit: (result: { code: number | null; signal: string | null }) => void = () => undefined
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        output = controller
      },
    })
    const emit = (value: unknown) => output.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`))
    return {
      success: true,
      target: "remote",
      pid: 0,
      pgid: 0,
      extra: [],
      stdout,
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited: new Promise((resolve) => {
        exit = resolve
      }),
      kill: () => {
        output.close()
        exit({ code: 0, signal: null })
      },
      stdin: new WritableStream({
        write: (chunk) => {
          const request = JSON.parse(new TextDecoder().decode(chunk))
          if (provider === "codex" && typeof request.id === "number")
            emit({ id: request.id, result: { thread: { id: "fixture-session" }, turn: { id: "fixture-turn" } } })
          if (
            (provider === "codex" && request.method === "turn/start") ||
            (provider === "claude" && request.type === "user")
          ) {
            for (const frame of frames) emit(frame)
            emit(
              provider === "codex"
                ? { method: "turn/completed", params: { status: "succeeded" } }
                : { type: "result", is_error: false },
            )
          }
        },
      }),
    }
  }
  const kernel: Kernel = {
    ...redactor,
    paths: createAppPaths({ appData: join(root, "data") }),
    services: createServices(),
    spawnTree: spawn,
    newId: randomUUID,
    log: () => undefined,
    db: {},
    publish: () => undefined,
    subscribe: () => () => undefined,
    registerRoutes: () => undefined,
    registerTools: () => ({ success: true, count: 0 }),
    callHost: async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "Host unavailable" }),
    onHostNotification: () => () => undefined,
    shellEnv: async () => ({}),
  }
  const options = { kernel, command: process.execPath }
  const adapter = provider === "codex" ? createCodexAdapter(options) : createClaudeAdapter(options)
  cleanup.push(async () => {
    await adapter.shutdown()
    rmSync(root, { recursive: true, force: true })
  })
  const events: ProviderEvent[] = []
  const result = await adapter.startTurn({
    bot: {
      provider,
      access: "full",
      approvals: "on-request",
      homeDir: root,
      model: null,
      reasoningEffort: null,
    } as Bot,
    thread: { id: "thread-review" } as Thread,
    session: null,
    fingerprint: { cwd: root } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "Review the action" }],
    developerInstructions: "Test approvals.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: { HOME: root },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  })
  expect(result.success).toBe(true)
  const event = events.find((event) => event.type === "approval_request" && event.part.decision === "pending")
  if (event?.type !== "approval_request") throw new Error("Missing approval")
  return { part: event.part, payload: JSON.parse(event.part.detail), root, events, kernel }
}

test("Codex approval retains its command, folder, reason and access while omitting transport metadata", async () => {
  const f = await run("codex", [
    {
      method: "item/started",
      params: {
        item: { id: "command-review", type: "commandExecution", command: "bun test", cwd: "/workspace/project" },
      },
    },
    {
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "command-review",
        threadId: "fixture-session",
        turnId: "fixture-turn",
        startedAtMs: 12345,
        reason: "Sandbox failed to start: registered-fixture-secret",
        additionalPermissions: { network: true },
      },
    },
  ])
  expect(f.part.request).toBe("command")
  expect(f.payload).toMatchObject({
    command: "bun test",
    cwd: "/workspace/project",
    reason: "Sandbox failed to start: [REDACTED]",
    additionalPermissions: { network: true },
  })
  expect(f.part.detail).not.toMatch(
    /fixture-session|fixture-turn|command-review|startedAtMs|12345|registered-fixture-secret/,
  )
})

test("Codex file approvals carry item changes and diffs even when the approval frame omits them", async () => {
  const changes = [{ path: "README.md", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new" }]
  const f = await run("codex", [
    { method: "item/started", params: { item: { id: "change-review", type: "fileChange", changes } } },
    {
      id: 99,
      method: "item/fileChange/requestApproval",
      params: { itemId: "change-review", reason: "Update documentation", grantRoot: "/workspace/project" },
    },
  ])
  expect(f.part.request).toBe("file_change")
  expect(f.payload).toMatchObject({ changes, cwd: f.root, grantRoot: "/workspace/project" })
  expect(f.events.find((event) => event.type === "item")?.part).toMatchObject({
    paths: ["README.md"],
    diff: changes[0]?.diff,
  })
})

test("Codex missing file lists remain absent rather than becoming invented targets", async () => {
  const f = await run("codex", [
    {
      id: 99,
      method: "item/fileChange/requestApproval",
      params: { itemId: "unknown", grantRoot: null, reason: "command failed; retry without sandbox?" },
    },
  ])
  expect(f.payload).toMatchObject({ cwd: f.root, grantRoot: null, reason: "command failed; retry without sandbox?" })
  expect(f.payload.paths).toBeUndefined()
  expect(f.payload.changes).toBeUndefined()
})

test("Codex permission approvals retain requested read/write paths and network access", async () => {
  const permissions = {
    fileSystem: { read: ["/workspace/docs"], write: ["/workspace/project"] },
    network: { enabled: true },
  }
  const f = await run("codex", [
    { id: 99, method: "item/permissions/requestApproval", params: { permissions, reason: "Read documentation" } },
  ])
  expect(f.part.request).toBe("permission")
  expect(f.payload).toMatchObject({ permissions, cwd: f.root, reason: "Read documentation" })
})

for (const [toolName, request, input] of [
  ["Bash", "command", { command: "bun test" }],
  ["Edit", "file_change", { file_path: "README.md", old_string: "old", new_string: "new" }],
  ["Read", "permission", { file_path: "README.md" }],
] as const) {
  test(`Claude ${toolName} approvals preserve reason and folder without changing execution input`, async () => {
    const f = await run("claude", [
      {
        type: "approval_request",
        approval_id: "private-approval",
        tool_name: toolName,
        input,
        reason: "Review registered-fixture-secret",
      },
    ])
    expect(f.part.request).toBe(request)
    expect(f.part.scope).toEqual({ source: "claude", tool: toolName })
    expect(f.payload).toMatchObject({ ...input, approvalContext: { cwd: f.root, reason: "Review [REDACTED]" } })
    expect(f.part.detail).not.toContain("private-approval")
  })
}

test("Claude permission bridge includes the actual tool folder and keeps large reviews valid without altering execution input", async () => {
  const f = await run("claude", [{ type: "approval_request", tool_name: "Bash", input: { command: "bun test" } }])
  const bot = { id: "bot-review", machine: "local" } as Bot
  const thread = { id: "thread-review", botId: bot.id } as Thread
  f.kernel.services.provide("store.api", createTestStore({ bot, thread, publish: f.kernel.publish }))
  const cards: ApprovalPart[] = []
  const bridge = createApprovalBridge({
    kernel: f.kernel,
    onCard: (_, card) => {
      cards.push(card)
      return true
    },
  })
  const ctx: ToolContext = {
    botId: bot.id,
    threadId: thread.id,
    runId: null,
    projectId: null,
    cwd: "/workspace/project",
    signal: new AbortController().signal,
  }
  const input = { file_path: "large.md", content: "Review\n".repeat(1500) }
  try {
    const pending = bridge.present({ ctx, toolName: "Write", scope: { source: "claude", tool: "Write" }, input })
    const card = cards[0]
    if (!card) throw new Error("Missing approval")
    expect(card.request).toBe("file_change")
    expect(JSON.parse(card.detail.slice("Write: ".length))).toEqual({ ...input, approvalContext: { cwd: ctx.cwd } })
    await bridge.approve({ approvalId: card.approvalId, decision: "approved" })
    expect(await pending).toMatchObject({ behavior: "allow", updatedInput: input })
    expect(input).not.toHaveProperty("approvalContext")
  } finally {
    bridge.dispose()
  }
})
