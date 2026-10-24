import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Result, StartTurnArgs } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initMcp, stop as stopMcp } from "../../src/mcp"
import { createApprovalContextHandler, createApprovalPromptHandler } from "../../src/runtime"
import { claudeSettings } from "../../src/runtime/claude/settings"

type Decision = Result<
  { behavior: "allow" | "deny"; updatedInput?: unknown; message?: string },
  "NOT_FOUND" | "TIMEOUT" | "DENIED"
>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
const fixture = async (decide: (input: unknown) => Decision, approvalContext: string | null = null) => {
  const root = mkdtempSync(join(tmpdir(), "touri-r3-permission-"))
  const runtime = createKernel({ appData: root })
  const db = runtime.kernel.db as Database
  db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','r3','claude',?,1,1)").run(
    root,
  )
  db.query(
    "INSERT INTO threads(id,bot_id,kind,title,created_at,updated_at) VALUES ('thread','bot','chat','r3',1,1)",
  ).run()
  await initMcp(runtime.kernel)
  let prompted = 0
  runtime.kernel.registerTools({
    tools: [
      {
        name: "approval_context",
        group: "core",
        handler: createApprovalContextHandler({ context: () => approvalContext }),
      },
      {
        name: "approval_prompt",
        group: "core",
        handler: createApprovalPromptHandler({
          approvalPrompt: async ({ input }) => {
            prompted++
            return decide(input)
          },
        }),
      },
    ],
  })
  mkdirSync(join(root, "run/mcp-tokens"), { recursive: true })
  writeFileSync(join(root, "run/mcp-tokens/thread"), "a".repeat(64), { mode: 0o600 })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", join(import.meta.dir, "../../src/main.ts"), "mcp-stdio", "--thread", "thread"],
    env: { PATH: process.env.PATH ?? "", TOURI_APP_DATA: root },
    stderr: "pipe",
  })
  const client = new Client({ name: "r3-contract", version: "1" })
  cleanup.push(async () => {
    await client.close().catch(() => undefined)
    await stopMcp({ kernel: runtime.kernel })
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, client, transport, prompts: () => prompted }
}

test("Claude post-tool hook returns model context as JSON text over the authenticated MCP shim", async () => {
  const note = "Aprovado pelo usuário (uma vez)."
  const f = await fixture((input) => ({ success: true, behavior: "allow", updatedInput: input }), note)
  await f.client.connect(f.transport)
  const result = await f.client.callTool({
    name: "approval_context",
    arguments: {
      tool_name: "Bash",
      tool_use_id: "private-tool-use",
      input: JSON.stringify({ command: "gh pr list" }),
      hook_event_name: "PostToolUse",
    },
  })
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } }),
    },
  ])
  expect(result.structuredContent).toBeUndefined()
  expect(result.isError).toBe(false)
  expect(JSON.stringify(result)).not.toContain("private-tool-use")
  expect(f.prompts()).toBe(0)
})

// This smoke uses a loopback Anthropic fixture, never the real provider or account.
test.skipIf(process.env.TOURI_E2E_LOCAL_CLAUDE !== "1" || Bun.which("claude") === null)(
  "real Claude CLI adds the approval hook context to its next model request (loopback provider)",
  async () => {
    const note = "Aprovado pelo usuário (uma vez)."
    const f = await fixture((input) => ({ success: true, behavior: "allow", updatedInput: input }), note)
    const requests: unknown[] = []
    const model = "claude-sonnet-4-5"
    const provider = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path.endsWith("/count_tokens")) return Response.json({ input_tokens: 10 })
        if (!path.endsWith("/messages")) return new Response(null, { status: 404 })
        requests.push(await request.json())
        const useTool = requests.length === 1
        const frames = [
          [
            "message_start",
            {
              type: "message_start",
              message: {
                id: `msg_${requests.length}`,
                type: "message",
                role: "assistant",
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            },
          ],
          [
            "content_block_start",
            {
              type: "content_block_start",
              index: 0,
              content_block: useTool
                ? { type: "tool_use", id: "toolu_local", name: "Bash", input: {} }
                : { type: "text", text: "" },
            },
          ],
          [
            "content_block_delta",
            {
              type: "content_block_delta",
              index: 0,
              delta: useTool
                ? {
                    type: "input_json_delta",
                    partial_json: JSON.stringify({ command: "printf touri-fixture", description: "Show fixture" }),
                  }
                : { type: "text_delta", text: "Concluído." },
            },
          ],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          [
            "message_delta",
            {
              type: "message_delta",
              delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 20 },
            },
          ],
          ["message_stop", { type: "message_stop" }],
        ]
        return new Response(
          frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
    })
    const config = join(f.root, "mcp.json")
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          touri: {
            command: process.execPath,
            args: ["run", join(import.meta.dir, "../../src/main.ts"), "mcp-stdio", "--thread", "thread"],
            env: { TOURI_APP_DATA: f.root },
          },
        },
      }),
    )
    const settings = join(f.root, "settings.json")
    const { settings: isolated } = await claudeSettings(
      { bot: { access: "full", approvals: "on-request" } } as StartTurnArgs,
      { HOME: f.root },
    )
    writeFileSync(settings, JSON.stringify(isolated))
    const child = Bun.spawn({
      cmd: [
        Bun.which("claude") ?? "claude",
        "-p",
        "Use Bash once to show the fixture, then reply done.",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--setting-sources=",
        "--settings",
        settings,
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "mcp__touri__approval_prompt",
        "--max-turns",
        "3",
      ],
      cwd: f.root,
      env: {
        ...process.env,
        HOME: f.root,
        CLAUDE_CONFIG_DIR: join(f.root, ".claude"),
        CLAUDECODE: undefined,
        ANTHROPIC_API_KEY: "local-fixture-key",
        ANTHROPIC_AUTH_TOKEN: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
        CLAUDE_CODE_USE_BEDROCK: undefined,
        CLAUDE_CODE_USE_VERTEX: undefined,
        CLAUDE_CODE_USE_FOUNDRY: undefined,
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        ALL_PROXY: undefined,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 100_000)
    try {
      const [output, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(output + stderr).not.toContain("Permission prompt tool returned an invalid result")
      expect(code, (output + stderr).slice(-3000)).toBe(0)
      expect(f.prompts()).toBe(1)
      expect(JSON.stringify(requests.slice(1)).includes(note)).toBe(true)
      expect(JSON.stringify(requests.slice(1)).includes("touri-fixture")).toBe(true)
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
      provider.stop(true)
    }
  },
  110_000,
)

for (const decision of ["allow", "deny", "timeout"] as const) {
  test(`P1-2 approval contract: ${decision} is exactly one JSON text block over the real shim`, async () => {
    const input = { command: 'printf "hora"', description: "Show current time", nested: { paths: ["a", "b"] } }
    const f = await fixture((value) =>
      decision === "allow"
        ? { success: true, behavior: "allow", updatedInput: value }
        : decision === "deny"
          ? { success: true, behavior: "deny", message: "Negado pelo usuário" }
          : { success: false, errorCode: "TIMEOUT", error: "Aprovação expirou" },
    )
    await f.client.connect(f.transport)
    const result = await f.client.callTool({ name: "approval_prompt", arguments: { tool_name: "Bash", input } })
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          decision === "allow"
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: decision === "deny" ? "Negado pelo usuário" : "Aprovação expirou" },
        ),
      },
    ])
    expect(result.structuredContent).toBeUndefined()
    expect(result.isError).toBe(false)
    expect(f.prompts()).toBe(1)
  })
}

test.skipIf(process.env.TOURI_E2E_REAL_CLI !== "1" || Bun.which("claude") === null)(
  "P1-2 real Claude CLI accepts a permission prompt and executes the approved tool",
  async () => {
    const f = await fixture((input) => ({ success: true, behavior: "allow", updatedInput: input }))
    const workspace = join(f.root, "workspace")
    mkdirSync(workspace)
    const target = join(f.root, "approved.txt")
    const config = join(f.root, "mcp.json")
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          touri: {
            command: process.execPath,
            args: ["run", join(import.meta.dir, "../../src/main.ts"), "mcp-stdio", "--thread", "thread"],
            env: { TOURI_APP_DATA: f.root },
          },
        },
      }),
    )
    const settings = join(f.root, "settings.json")
    mkdirSync(join(workspace, ".claude"))
    writeFileSync(
      join(workspace, ".claude/settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(*)"], defaultMode: "auto" } }),
    )
    writeFileSync(settings, JSON.stringify({ permissions: { ask: ["Bash"], allow: [], deny: [] } }))
    const child = Bun.spawn({
      cmd: [
        Bun.which("claude") ?? "claude",
        "-p",
        `Use Bash exactly once to run: printf approved > '${target}'. Then reply done.`,
        "--output-format",
        "stream-json",
        "--verbose",
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--setting-sources=",
        "--settings",
        settings,
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "mcp__touri__approval_prompt",
      ],
      cwd: workspace,
      env: { ...process.env, CLAUDECODE: undefined },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 100_000)
    try {
      const [output, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(output + stderr).not.toContain("Permission prompt tool returned an invalid result")
      expect(code).toBe(0)
      expect(f.prompts()).toBeGreaterThan(0)
      expect(readFileSync(target, "utf8")).toBe("approved")
    } finally {
      clearTimeout(timer)
      child.kill()
      await child.exited
    }
  },
  110_000,
)

for (const [command, defaultPrompts] of [
  ["git status --short", 0],
  ["gh pr list", 1],
] as const) {
  for (const forceAsk of [false, true]) {
    test.skipIf(process.env.TOURI_E2E_REAL_CLI !== "1" || Bun.which("claude") === null)(
      `real Claude ${forceAsk ? "ask Bash" : "default"} prompts ${forceAsk ? 1 : defaultPrompts} times for ${command}`,
      async () => {
        const f = await fixture(() => ({ success: true, behavior: "deny", message: "Denied by test" }))
        if (command === "git status --short") {
          expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: f.root }).exitCode).toBe(0)
          writeFileSync(join(f.root, "readonly-proof.txt"), "read-only control")
        }
        const config = join(f.root, "mcp.json")
        writeFileSync(
          config,
          JSON.stringify({
            mcpServers: {
              touri: {
                command: process.execPath,
                args: ["run", join(import.meta.dir, "../../src/main.ts"), "mcp-stdio", "--thread", "thread"],
                env: { TOURI_APP_DATA: f.root },
              },
            },
          }),
        )
        const child = Bun.spawn({
          cmd: [
            Bun.which("claude") ?? "claude",
            "-p",
            `Use Bash exactly once to run: ${command}. Do not use any other tools or retry if denied. Reply done.`,
            "--output-format",
            "stream-json",
            "--verbose",
            "--mcp-config",
            config,
            "--strict-mcp-config",
            "--setting-sources=",
            "--settings",
            JSON.stringify({ permissions: { allow: [], deny: [], ask: forceAsk ? ["Bash"] : [] } }),
            "--permission-mode",
            "default",
            "--permission-prompt-tool",
            "mcp__touri__approval_prompt",
          ],
          cwd: f.root,
          env: { ...process.env, CLAUDECODE: undefined },
          stdout: "pipe",
          stderr: "pipe",
        })
        const timer = setTimeout(() => child.kill(), 100_000)
        try {
          const [output, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ])
          expect(output + stderr).not.toContain("Permission prompt tool returned an invalid result")
          expect(code).toBe(0)
          const frames = output
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  type: string
                  message?: { content?: Array<{ type: string; name?: string; input?: { command?: string } }> }
                },
            )
          const bashCalls = frames
            .filter((frame) => frame.type === "assistant")
            .flatMap((frame) => frame.message?.content ?? [])
            .filter((item) => item.type === "tool_use" && item.name === "Bash")
          expect(bashCalls.map((item) => item.input?.command)).toEqual([command])
          if (command === "git status --short" && !forceAsk)
            expect(JSON.stringify(frames.filter((frame) => frame.type === "user"))).toContain("readonly-proof.txt")
          expect(f.prompts()).toBe(forceAsk ? 1 : defaultPrompts)
        } finally {
          clearTimeout(timer)
          child.kill()
          await child.exited
        }
      },
      110_000,
    )
  }
}
