import { afterEach, expect, mock, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Bot, Kernel, StartTurnArgs, Thread } from "@touri/contracts"
import { saveApiModel } from "../../src/api-models/config"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { createOpenCodeAdapter } from "../../src/runtime/opencode/adapter"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()
afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

const invalidModels = [
  "--help",
  " -config ",
  "demo\u0000model",
  "demo\tmodel",
  "demo\n",
  "demo\u007fmodel",
  "demo\u0085model",
  "demo\u200bmodel",
  "demo\u202emodel",
  "demo\u2028model",
  "demo\u2029model",
  "demo\ud800model",
  "demo\u034fmodel",
  "demo\ufe0fmodel",
  "m".repeat(257),
  "touri-api-demo/test\nmodel",
]

test.each(invalidModels)("Claude rejects stored model %j before startup", async (model) => {
  const fixture = makeFixture("claude", model)

  await expectRejectedBeforeStartup(fixture)
})

test.each(invalidModels)("OpenCode rejects stored model %j before startup", async (model) => {
  const fixture = makeFixture("opencode", model)

  await expectRejectedBeforeStartup(fixture)
})

const models = [
  'demo"model',
  "demo'model",
  "demo=model",
  "demo#model",
  '["demo"]',
  "{name='demo'}",
  '"demo" # comment',
  'demo\\model"=#[]{}',
  "sonnet",
  "provider/model:latest",
  "modelo-ação-😀",
  "m".repeat(256),
  " demo-model ",
  null,
  undefined,
  "",
  "   ",
]

test.each(models)("Claude passes model %j as one argv value locally and in the guest", async (model) => {
  const { adapter, args, spawn, writeFile, fixture } = makeFixture("claude", model)
  const guestArgs = Object.assign({}, args, { execution: { spawn, writeFile } })

  await adapter.startTurn(args)
  await adapter.startTurn(guestArgs)

  const calls = spawn.mock.calls.filter(([input]) => input.cmd !== "cat")
  expect(calls).toHaveLength(2)
  calls.forEach(([input]) => {
    const index = input.args.indexOf("--model")
    const expected = model?.trim() || null
    if (!expected) {
      expect(index).toBe(-1)
      return
    }

    expect(input.args.filter((value) => value === "--model")).toHaveLength(1)
    expect(input.args[index + 1]).toBe(expected)
    expect(input.args.filter((value) => value === expected)).toHaveLength(1)
    expect(input.args[index + 2]).toBe("--effort")
  })
  expect(args.bot).toMatchObject({ model })
  expect(fixture.spawnTree).not.toHaveBeenCalled()
})

const expectRejectedBeforeStartup = async ({
  adapter,
  args,
  spawn,
  writeFile,
  callHost,
  fixture,
}: ReturnType<typeof makeFixture>) => {
  const guestArgs = Object.assign({}, args, { execution: { spawn, writeFile } })

  const local = await adapter.startTurn(args)
  const guest = await adapter.startTurn(guestArgs)

  expect(local).toEqual({
    success: false,
    errorCode: "unknown",
    error: "The saved model name is invalid. Choose another model in the bot settings.",
  })
  expect(guest).toEqual(local)
  expect(spawn).not.toHaveBeenCalled()
  expect(fixture.spawnTree).not.toHaveBeenCalled()
  expect(writeFile).not.toHaveBeenCalled()
  expect(callHost).not.toHaveBeenCalled()
  expect(existsSync(fixture.kernel.paths.runDir)).toBe(false)
}

const makeFixture = (provider: "claude" | "opencode", model: string | null | undefined) => {
  const fixture = testKernel()
  fixtures.add(fixture)
  if (provider === "opencode") {
    fixture.db
      .query("INSERT INTO secrets(id,name,keychain_account,usage_json,created_at,updated_at) VALUES (?,?,?,?,1,1)")
      .run("demo", "OPENROUTER_API_KEY", "demo/account", JSON.stringify({ env: true }))
    saveApiModel(fixture.kernel, {
      id: "demo",
      preset: "custom",
      name: "Demo API",
      modelId: "test\nmodel",
      baseUrl: "https://example.com/v1",
    })
  }
  const spawn = mock<Kernel["spawnTree"]>((input) => {
    if (input.cmd === "cat") return getSettingsProcess()
    return { success: false, errorCode: "SPAWN_FAILED", error: "Fixture stopped at the CLI boundary" }
  })
  const callHost = mock<Kernel["callHost"]>(fixture.kernel.callHost)
  const writeFile = mock(async () => undefined)
  const kernel = Object.assign({}, fixture.kernel, { spawnTree: spawn, callHost })
  const createAdapter = provider === "claude" ? createClaudeAdapter : createOpenCodeAdapter
  const adapter = createAdapter({ kernel, command: process.execPath })
  const args: StartTurnArgs = {
    bot: {
      provider,
      access: "full",
      approvals: "never",
      homeDir: kernel.paths.appData,
      projectId: null,
      model,
      reasoningEffort: "high",
    } as Bot,
    thread: { id: "model-thread" } as Thread,
    session: null,
    fingerprint: { cwd: kernel.paths.appData } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "Olá" }],
    developerInstructions: "Synthetic model test.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: { HOME: kernel.paths.appData, CLAUDE_CONFIG_DIR: join(kernel.paths.appData, "settings") },
    signal: new AbortController().signal,
    onEvent: () => undefined,
  }

  return { fixture, adapter, args, spawn, writeFile, callHost }
}

const getSettingsProcess = (): ReturnType<Kernel["spawnTree"]> => ({
  success: true,
  pid: 0,
  pgid: 0,
  stdout: new Response("{}").body ?? new ReadableStream<Uint8Array>(),
  stderr: new Response("").body ?? new ReadableStream<Uint8Array>(),
  stdin: new WritableStream<Uint8Array>(),
  extra: [],
  exited: Promise.resolve({ code: 0, signal: null }),
  kill: () => undefined,
})
