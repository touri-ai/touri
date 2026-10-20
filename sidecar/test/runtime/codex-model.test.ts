import { afterEach, expect, mock, test } from "bun:test"
import type { Bot, Kernel, StartTurnArgs, Thread } from "@touri/contracts"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()
afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

const models = [
  'demo"model',
  "demo'model",
  "demo=model",
  "demo#model",
  '["demo"]',
  "{name='demo'}",
  '"demo" # comment',
  'demo\\"model',
  'demo\\model"=#[]{}',
  "true",
  "123",
  "provider/model:latest",
  "modelo-ação-😀",
  "m".repeat(256),
  " demo-model ",
  null,
  undefined,
  "",
  "   ",
]

test.each(models)("passes model %j as one literal TOML string", async (model) => {
  const { adapter, args, spawn } = makeFixture(model)

  await adapter.startTurn(args)
  await adapter.startTurn({ ...args, execution: { spawn, writeFile: async () => undefined } })

  expect(spawn).toHaveBeenCalledTimes(2)
  spawn.mock.calls.forEach(([input]) => {
    const modelArgs = input.args.filter((value) => value.startsWith("model="))
    const expected = model?.trim() || null
    if (!expected) {
      expect(modelArgs).toEqual([])
      return
    }

    expect(modelArgs).toHaveLength(1)
    const assignment = modelArgs[0] ?? ""
    const index = input.args.indexOf(assignment)
    expect(input.args[index - 1]).toBe("-c")
    expect(Bun.TOML.parse(assignment)).toEqual({ model: expected })
  })
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
]

test.each(invalidModels)("rejects stored model %j before local or guest spawning", async (model) => {
  const { adapter, args, spawn, fixture } = makeFixture(model)
  const guestArgs: StartTurnArgs = { ...args, execution: { spawn, writeFile: async () => undefined } }

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
})

const makeFixture = (model: string | null | undefined) => {
  const fixture = testKernel()
  fixtures.add(fixture)
  const spawn = mock<Kernel["spawnTree"]>(() => ({
    success: false,
    errorCode: "SPAWN_FAILED",
    error: "Fixture stopped at the CLI boundary",
  }))
  const adapter = createCodexAdapter({ kernel: { ...fixture.kernel, spawnTree: spawn }, command: process.execPath })
  const args: StartTurnArgs = {
    bot: {
      provider: "codex",
      access: "full",
      approvals: "on-request",
      homeDir: fixture.kernel.paths.appData,
      model,
    } as Bot,
    thread: { id: "model-thread" } as Thread,
    session: null,
    fingerprint: { cwd: fixture.kernel.paths.appData } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "Olá" }],
    developerInstructions: "Synthetic model test.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: {},
    signal: new AbortController().signal,
    onEvent: () => undefined,
  }

  return { fixture, adapter, args, spawn }
}
