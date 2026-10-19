import { expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { createHarness } from "../projects/harness"

setDefaultTimeout(15_000)

const fakeProviderSource = [
  "const dump = process.env.TOURI_SECURITY_ENV_DUMP;",
  "if (dump) await Bun.write(dump, JSON.stringify(process.env));",
  "const output = (value) => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));",
  "let buffer = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  let newline = buffer.indexOf(String.fromCharCode(10));",
  "  while (newline >= 0) {",
  "    const request = JSON.parse(buffer.slice(0, newline));",
  "    buffer = buffer.slice(newline + 1);",
  "    newline = buffer.indexOf(String.fromCharCode(10));",
  "    if (request.method === 'initialize') output({ jsonrpc: '2.0', id: request.id, result: {} });",
  "    if (request.method === 'thread/start') output({ jsonrpc: '2.0', id: request.id, result: { thread: { id: 'fake-session' } } });",
  "    if (request.method === 'turn/start') {",
  "      output({ jsonrpc: '2.0', id: request.id, result: { turn: { id: 'fake-turn' } } });",
  "      output({ method: 'turn/started', params: { turnId: 'fake-turn' } });",
  "      output({ method: 'turn/completed', params: { status: 'succeeded', turnId: 'fake-turn' } });",
  "    }",
  "  }",
  "});",
].join(String.fromCharCode(10))

const withEnvironment = async <T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> => {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const bot = (root: string): Bot => {
  const timestamp = Date.now()
  return {
    teamBuilder: false,
    id: "bot-env",
    name: "env",
    title: null,
    description: null,
    color: null,
    avatarPath: null,
    instructions: "Test",
    instructionsHash: "hash",
    provider: "codex",
    model: null,
    reasoningEffort: "medium",
    access: "workspace-write",
    approvals: "on-request",
    projectId: null,
    cwd: root,
    homeDir: root,
    mainThreadId: "thread-env",
    browserEnabled: false,
    browser: "touri",
    computerUse: false,
    machine: "local",
    machineIdleMinutes: 15,
    vmProviderLogin: false,
    hostComputerUse: false,
    notifications: "all",
    section: null,
    sortOrder: 0,
    paused: false,
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  }
}

const thread = (_root: string): Thread => {
  const timestamp = Date.now()
  return {
    id: "thread-env",
    botId: "bot-env",
    parentThreadId: null,
    kind: "main",
    title: "Environment",
    activeLeafId: null,
    routineRunId: null,
    cwdOverride: null,
    unread: 0,
    carryoverNote: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: null,
      turns: 0,
      contextTokens: null,
      contextWindow: null,
    },
    source: "local",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  }
}

test("provider children receive no internal auth or MCP token environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-security-provider-"))
  const dumpPath = join(root, "provider-env.json")
  const fakePath = join(root, "fake-codex")
  const fakeSource = join(root, "fake-codex.ts")
  writeFileSync(fakeSource, fakeProviderSource)
  writeFileSync(
    fakePath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(fakeSource)} "$@"\n`,
    {
      mode: 0o700,
    },
  )
  chmodSync(fakePath, 0o700)
  const runtime = createKernel({ appData: root })
  const spawn = runtime.kernel.spawnTree
  // Add only the test instrument after filtering; keep the actual namespace and
  // every internal credential exactly as the provider boundary supplied them.
  runtime.kernel.spawnTree = (input) => spawn({ ...input, env: { ...input.env, TOURI_SECURITY_ENV_DUMP: dumpPath } })
  const adapter = createCodexAdapter({ kernel: runtime.kernel, command: fakePath })
  const argsEnv = {
    PATH: process.env.PATH ?? "/usr/bin",
    SHELL: process.env.SHELL ?? "/bin/zsh",
    TOURI_APP_DATA: root,
    TOURI_SECURITY_ENV_DUMP: dumpPath,
    TOURI_UI_TOKEN: "args-ui-token",
    TOURI_HOST_TOKEN: "args-host-token",
    TOURI_HOST_SOCK: join(root, "host.sock"),
    TOURI_MCP_TOKEN: "args-mcp-token",
    TOURI_INTERNAL_AUTH: "args-internal-auth",
  }
  try {
    const result = await withEnvironment(
      {
        TOURI_UI_TOKEN: "process-ui-token",
        TOURI_HOST_TOKEN: "process-host-token",
        TOURI_HOST_SOCK: join(root, "process-host.sock"),
        TOURI_MCP_TOKEN: "process-mcp-token",
        TOURI_INTERNAL_AUTH: "process-internal-auth",
      },
      () =>
        adapter.startTurn({
          thread: thread(root),
          bot: bot(root),
          session: null,
          fingerprint: {
            provider: "codex",
            cwd: root,
            access: "workspace-write",
            mcpServers: [],
            toolsetVersion: "test",
          },
          input: [{ type: "text", text: "test" }],
          developerInstructions: "test",
          handoffPacket: null,
          mcp: { command: fakePath, args: [], env: { TOURI_APP_DATA: root } },
          env: argsEnv,
          onEvent: () => undefined,
          signal: new AbortController().signal,
        }),
    )
    expect(result.success).toBe(true)
    const childEnvironment = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, string | undefined>
    for (const key of [
      "TOURI_UI_TOKEN",
      "TOURI_HOST_TOKEN",
      "TOURI_HOST_SOCK",
      "TOURI_MCP_TOKEN",
      "TOURI_INTERNAL_AUTH",
    ])
      expect(childEnvironment[key]).toBeUndefined()
    expect(childEnvironment.PATH).toBeString()
    expect(childEnvironment.SHELL).toBeString()
    expect(childEnvironment.TOURI_APP_DATA).toBe(root)
  } finally {
    await adapter.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("supervised project children receive no internal auth or MCP token environment", async () => {
  await withEnvironment(
    {
      TOURI_MCP_TOKEN: "process-mcp-token",
      TOURI_INTERNAL_AUTH: "process-internal-auth",
    },
    async () => {
      const harness = await createHarness()
      try {
        const response = await harness.request("/projects", {
          method: "POST",
          body: JSON.stringify({ path: harness.projectPath }),
          headers: { "Content-Type": "application/json" },
        })
        expect(response.status).toBe(201)
        const body = (await response.json()) as { project: { id: string } }
        const dumpPath = join(harness.projectPath, "project-env.json")
        writeFileSync(
          join(harness.projectPath, "dump-project-env.ts"),
          `await Bun.write(${JSON.stringify(dumpPath)}, JSON.stringify(process.env)); setInterval(() => {}, 1000)\n`,
        )
        const defined = await harness.tool(
          "process_define",
          {
            name: "env-dump",
            command: "bun dump-project-env.ts",
            env: {
              TOURI_UI_TOKEN: "spec-ui-token",
              TOURI_HOST_TOKEN: "spec-host-token",
              TOURI_HOST_SOCK: "spec-host-sock",
              TOURI_MCP_TOKEN: "spec-mcp-token",
              TOURI_INTERNAL_AUTH: "spec-internal-auth",
            },
          },
          body.project.id,
        )
        expect(defined.success).toBe(true)
        const started = await harness.tool("process_start", { name: "env-dump", waitMs: 3_000 }, body.project.id)
        expect(started.success).toBe(true)
        const deadline = Date.now() + 10_000
        while (!existsSync(dumpPath) && Date.now() < deadline) await Bun.sleep(25)
        const childEnvironment = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, string | undefined>
        for (const key of [
          "TOURI_UI_TOKEN",
          "TOURI_HOST_TOKEN",
          "TOURI_HOST_SOCK",
          "TOURI_MCP_TOKEN",
          "TOURI_INTERNAL_AUTH",
        ])
          expect(childEnvironment[key]).toBeUndefined()
        expect(childEnvironment.PATH).toBeString()
        expect(childEnvironment.SHELL).toBeString()
        await harness.tool("process_stop", { name: "env-dump" }, body.project.id)
      } finally {
        await harness.close()
      }
    },
  )
}, 30_000)
