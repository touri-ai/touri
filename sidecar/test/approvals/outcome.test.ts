import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, NotificationRecord, ToolContext } from "@touri/contracts"
import { createApprovalBridge } from "../../src/approvals/bridge"
import { approvalOutcome, withApprovalOutcome } from "../../src/approvals/outcome"
import { createKernel } from "../../src/kernel"
import { createApprovalContextHandler, createApprovalPromptHandler } from "../../src/runtime"
import { init as initStore } from "../../src/store"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-approval-outcome-"))
  const runtime = createKernel({ appData: root })
  await initStore(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.query(
    "INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','review','claude',?,1,1)",
  ).run(root)
  db.query(
    "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('thread','bot','chat','review',1,1)",
  ).run()
  const cards: ApprovalPart[] = []
  const bridge = createApprovalBridge({
    kernel: runtime.kernel,
    onCard: (_, part) => {
      cards.push(structuredClone(part))
      return true
    },
  })
  const ctx: ToolContext = {
    botId: "bot",
    threadId: "thread",
    runId: "private-run",
    projectId: null,
    cwd: root,
    signal: new AbortController().signal,
  }
  cleanup.push(() => {
    bridge.dispose()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { bridge, ctx, cards, runtime }
}

for (const toolUseId of [undefined, "private-tool-use-id"]) {
  test(`Claude approval outcome is model-visible hook context, scoped and consumed (tool-use id: ${!!toolUseId})`, async () => {
    const f = await fixture()
    const input = { command: "gh pr list", description: "List pull requests" }
    const hook = createApprovalContextHandler(f.bridge)
    const prompt = createApprovalPromptHandler({
      approvalPrompt: (args) => f.bridge.present({ ...args, scope: { source: "claude", tool: args.toolName } }),
    })
    for (const [standing, expected] of [
      [false, approvalOutcome.once],
      [true, approvalOutcome.standing],
    ] as const) {
      const response = prompt({
        ctx: f.ctx,
        args: { tool_name: "Bash", input, ...(toolUseId ? { tool_use_id: toolUseId } : {}) },
      })
      const card = f.cards.at(-1)
      if (!card) throw new Error("Missing approval card")
      await f.bridge.approve({ approvalId: card.approvalId, decision: "approved", standing })
      expect(f.cards.at(-1)).toMatchObject({
        decision: "approved",
        standing,
        botId: "bot",
        resolvedAt: expect.any(Number),
      })
      // The permission response stays in the exact CLI schema; metadata reaches
      // the model through additionalContext alongside the original tool result.
      expect(await response).toEqual({
        success: true,
        content: [{ type: "text", text: JSON.stringify({ behavior: "allow", updatedInput: input }) }],
      })
      const args = {
        tool_name: "Bash",
        tool_use_id: toolUseId ?? "hook-id",
        input: JSON.stringify({ description: input.description, command: input.command }),
        hook_event_name: "PostToolUse",
      }
      expect(await hook({ ctx: { ...f.ctx, runId: "another-run" }, args })).toMatchObject({ content: [{ text: "{}" }] })
      const context = await hook({ ctx: f.ctx, args })
      expect(context).toEqual({
        success: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: expected } }),
          },
        ],
      })
      expect(JSON.stringify(context)).not.toContain("private-")
      expect(await hook({ ctx: f.ctx, args })).toMatchObject({ content: [{ text: "{}" }] })
    }
    const automatic = await prompt({
      ctx: f.ctx,
      args: { tool_name: "Bash", input, ...(toolUseId ? { tool_use_id: toolUseId } : {}) },
    })
    expect(automatic.success).toBe(true)
    const context = await hook({
      ctx: f.ctx,
      args: { tool_name: "Bash", tool_use_id: toolUseId ?? "hook-id", input, hook_event_name: "PostToolUseFailure" },
    })
    expect(context).toMatchObject({
      content: [
        {
          text: JSON.stringify({
            hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: approvalOutcome.automatic },
          }),
        },
      ],
    })
    expect(f.cards.filter((card) => card.decision === "pending")).toHaveLength(2)
  })
}

test("deny is visible in the permission response and completed runs discard unconsumed context", async () => {
  const f = await fixture()
  const input = { ctx: f.ctx, scope: { source: "claude" as const, tool: "Write" }, toolName: "Write", input: {} }
  const pending = f.bridge.present(input)
  await f.bridge.approve({ approvalId: f.cards[0]?.approvalId ?? "", decision: "denied" })
  expect(await pending).toEqual({ success: true, behavior: "deny", message: approvalOutcome.denied })
  f.bridge.cancelRun(f.ctx.runId ?? "")
  expect(f.bridge.context(input)).toBeNull()
})

test("approval prompts and permission responses wait for the approval card write", async () => {
  const f = await fixture()
  const cards: ApprovalPart[] = []
  const releases: Array<() => void> = []
  let notified = false
  let resolveNotification: () => void = () => {}
  const notification = new Promise<void>((resolve) => {
    resolveNotification = resolve
  })
  const bridge = createApprovalBridge({
    kernel: f.runtime.kernel,
    onCard: async (_, part) => {
      cards.push(structuredClone(part))
      await new Promise<void>((resolve) => releases.push(resolve))
      return true
    },
  })
  f.runtime.kernel.services.provide("notify.emit", (input) => {
    if (input.kind === "approval") {
      notified = true
      resolveNotification()
    }
    return {} as NotificationRecord
  })
  try {
    const pending = bridge.present({
      ctx: f.ctx,
      toolName: "Write",
      scope: { source: "claude", tool: "Write" },
      input: { file_path: "draft.txt" },
    })
    expect(releases).toHaveLength(1)
    expect(notified).toBe(false)
    releases.shift()?.()
    await notification
    expect(notified).toBe(true)

    let completed = false
    const approved = bridge.approve({ approvalId: cards[0]?.approvalId ?? "", decision: "approved" }).then(() => {
      completed = true
    })
    expect(releases).toHaveLength(1)
    expect(completed).toBe(false)
    releases.shift()?.()
    await approved
    expect(await pending).toMatchObject({ success: true, behavior: "allow" })
    expect(cards.at(-1)).toMatchObject({ decision: "approved" })
  } finally {
    bridge.dispose()
  }
})

test("approval notes preserve images, structured payloads and failed tool results", () => {
  const content = [{ type: "image" as const, data: "image-data", mimeType: "image/png" as const }]
  const result = { success: true as const, content, structured: { screenshot: true } }
  expect(withApprovalOutcome(result, approvalOutcome.once)).toEqual({
    ...result,
    content: [{ type: "text", text: approvalOutcome.once }, ...content],
  })
  expect(result.content).toEqual(content)
  expect(
    withApprovalOutcome({ success: false, errorCode: "FAILED", error: "Falhou" }, approvalOutcome.once),
  ).toMatchObject({ success: false, error: "Falhou", content: [{ type: "text", text: approvalOutcome.once }] })
})

test("delegation consent keeps the waiting member on both pending and resolved cards", async () => {
  const scenario = await fixture()
  const input = {
    ctx: scenario.ctx,
    groupMemberId: "recipient",
    scope: { source: "mcp" as const, tool: "ask_bot" },
    toolName: "Delegar entre limites de acesso",
    input: { message: "Revise" },
    allowStanding: false,
  }

  const pending = scenario.bridge.present(input)
  const card = scenario.cards.at(-1)
  await scenario.bridge.approve({ approvalId: card?.approvalId ?? "", decision: "denied" })
  const result = await pending

  expect(card).toMatchObject({ groupMemberId: "recipient", decision: "pending" })
  expect(scenario.cards.at(-1)).toMatchObject({ groupMemberId: "recipient", decision: "denied" })
  expect(result).toMatchObject({ success: true, behavior: "deny" })
})
