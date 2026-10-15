import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderEvent, StartTurnArgs, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"

const LEAKED_TOKEN = "ghp_0123456789abcdefABCDEF"
const REGISTERED_SECRET = "registered-provider-secret-value"
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})

const fixture = (scenarioValue: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), "touri-provider-redaction-"))
  const runtime = createKernel({ appData: join(root, "data") })
  runtime.kernel.addRedactionValue(REGISTERED_SECRET)
  const scenario = join(root, "scenario.json")
  writeFileSync(scenario, JSON.stringify(scenarioValue))
  const spawn: Kernel["spawnTree"] = (spawnInput) =>
    runtime.kernel.spawnTree({
      ...spawnInput,
      cmd: process.execPath,
      args: ["run", join(import.meta.dir, "../fakes/fake-codex.ts"), ...spawnInput.args],
    })
  const adapter = createCodexAdapter({ kernel: { ...runtime.kernel, spawnTree: spawn }, command: process.execPath })
  const events: ProviderEvent[] = []
  const args: StartTurnArgs = {
    bot: { access: "full", approvals: "on-request", homeDir: root, model: null, reasoningEffort: null } as Bot,
    thread: { id: "thread-redaction" } as Thread,
    session: null,
    fingerprint: { cwd: root } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "hello" }],
    developerInstructions: "Test redaction.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: { HOME: root, TOURI_FAKE_SCENARIO: scenario },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
  }
  cleanups.push(() => {
    void adapter.shutdown()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { adapter, args, events }
}

test("#4 Codex stderr in a crash result is redacted at the adapter boundary", async () => {
  const f = fixture({
    crashAt: 1,
    stderr: `fatal: token=${LEAKED_TOKEN} while using ${REGISTERED_SECRET}`,
    events: [{ type: "delta", delta: "unused" }],
  })
  const result = await f.adapter.startTurn(f.args)
  expect(result).toMatchObject({ success: false, error: expect.stringContaining("[REDACTED]") })
  expect(JSON.stringify(result)).not.toContain(LEAKED_TOKEN)
  expect(JSON.stringify(result)).not.toContain(REGISTERED_SECRET)
})
