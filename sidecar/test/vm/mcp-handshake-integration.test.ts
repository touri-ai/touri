import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { init as initMcp, stop as stopMcp } from "../../src/mcp"
import { MCP_LIMITS } from "../../src/mcp/connection"
import { init as initStore } from "../../src/store"
import { createAppleContainerProvider } from "../../src/vm"
import { createVmRuntime } from "../../src/vm/runtime"
import { appleContainerAvailable } from "./integration-available"

// Codex gives an MCP server 10 s to answer initialize before it reports the tools as missing.
const CODEX_HANDSHAKE_MS = 10_000
// Each bridge connection is a `container exec socat`; while another VM boots, that exec was observed to
// be slow. Model a forward slower than the bridge auth deadline so the failure is deterministic.
const SLOW_FORWARD_S = (MCP_LIMITS.authMs + 500) / 1000

test.skipIf(!appleContainerAvailable)(
  "#3 real bot VM: the guest MCP shim completes its handshake with a slow forward, another VM booting and egress re-applied",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tvmh-"))
    const runtime = createKernel({ appData: root })
    const provider = createAppleContainerProvider()
    const hostHome = join(root, "host-home")
    mkdirSync(join(hostHome, ".codex"), { recursive: true })
    writeFileSync(join(hostHome, ".codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: "fake-integration-key" }), {
      mode: 0o600,
    })
    await initStore(runtime.kernel)
    await initMcp(runtime.kernel)
    const vm = createVmRuntime({
      kernel: runtime.kernel,
      provider,
      hostHome,
      connectionKeys: { rotate: async () => randomBytes(32), remove: async () => {} },
    })
    runtime.kernel.services.provide("vm.runtime", vm.service)
    const createBot = async (name: string) => {
      const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/bots`, {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-ui-token",
          "x-touri-client": "vm-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, provider: "codex", machine: "vm", vmProviderLogin: true }),
      })
      expect(response.status).toBe(201)
      const bot = ((await response.json()) as { bot: Bot }).bot
      ;(runtime.kernel.db as Database)
        .query("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)")
        .run(`vm-login-source:${bot.id}:codex`, '"host-file"', Date.now())
      return bot
    }
    const botIds: string[] = []
    let prepared: Awaited<ReturnType<typeof vm.service.prepareTurn>> | null = null
    try {
      const bot = await createBot("Handshake VM")
      botIds.push(bot.id)
      const viewerBot = await createBot("Viewer VM")
      botIds.push(viewerBot.id)
      const thread = runtime.kernel.services.use("store.api")?.getThread({ threadId: bot.mainThreadId ?? "" })
      if (!thread) throw new Error("Missing thread")
      const releaseBoot = await vm.service.acquire({ botId: bot.id })
      const vmId = (runtime.kernel.db as Database)
        .query("SELECT vm_id FROM bot_machines WHERE bot_id = ?")
        .get(bot.id) as { vm_id: string }
      const slowed = await provider.exec({
        id: vmId.vm_id,
        user: "0",
        command: "/bin/sh",
        args: [
          "-c",
          `mv /usr/bin/socat /usr/bin/socat.real && printf '#!/bin/sh\ncase "$*" in *:9876*) sleep ${SLOW_FORWARD_S};; esac\nexec /usr/bin/socat.real "$@"\n' > /usr/bin/socat && chmod 755 /usr/bin/socat`,
        ],
      })
      expect(slowed.success && slowed.code).toBe(0)
      await releaseBoot()
      const token = "b".repeat(64)
      writeFileSync(join(root, "run/mcp-tokens", thread.id), token, { mode: 0o600 })
      prepared = await vm.service.prepareTurn({ botId: bot.id, threadId: thread.id, token })
      const guest = prepared
      const handshake = async () => {
        const started = performance.now()
        const child = vm.service.spawn({ botId: bot.id, cmd: "node", args: guest.mcp.args, cwd: "/workspace", env: {} })
        if (!child.success) throw new Error(child.error)
        const writer = child.stdin.getWriter()
        await writer.write(
          new TextEncoder().encode(
            `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "vm-test", version: "1" } } })}\n`,
          ),
        )
        const reader = child.stdout.getReader()
        const stderr = new Response(child.stderr).text()
        let output = ""
        const answered = await Promise.race([
          (async () => {
            while (!output.includes('"id":1')) {
              const chunk = await reader.read()
              if (chunk.done) return false
              output += new TextDecoder().decode(chunk.value)
            }
            return true
          })(),
          Bun.sleep(CODEX_HANDSHAKE_MS).then(() => false),
        ])
        const ms = performance.now() - started
        child.kill("SIGKILL")
        await reader.cancel().catch(() => {})
        return { ok: answered && output.includes('"serverInfo"'), ms, stderr: answered ? "" : await stderr }
      }
      const baseline = await handshake()
      expect(baseline.ok).toBe(true)
      // Idle host connections are recycled by the bridge; wait across several cycles first.
      await Bun.sleep(12_000)
      const idle = await handshake()
      let busy = true
      const viewerBoot = (async () => {
        const release = await vm.service.acquire({ botId: viewerBot.id })
        await release()
      })().finally(() => {
        busy = false
      })
      const policies = (async () => {
        while (busy) {
          await vm.applyNetworkPolicy(bot.id)
          await vm.service.acquire({ botId: bot.id }).then((release) => release())
        }
      })()
      const concurrent: Array<Awaited<ReturnType<typeof handshake>>> = []
      while (busy) concurrent.push(await handshake())
      await Promise.all([viewerBoot, policies])
      const failures = [idle, ...concurrent].filter((result) => !result.ok)
      console.info(
        `[mcp handshake] baseline=${baseline.ms.toFixed(0)}ms idle=${idle.ms.toFixed(0)}ms concurrent=${concurrent
          .map((result) => `${result.ok ? "" : "FAIL:"}${result.ms.toFixed(0)}`)
          .join(",")} failures=${failures.map((result) => result.stderr.trim()).join(" | ")}`,
      )
      expect(concurrent.length).toBeGreaterThan(0)
      expect(failures).toEqual([])
    } finally {
      await prepared?.release()
      for (const botId of botIds) await vm.service.destroy({ botId }).catch(() => {})
      await vm.dispose()
      await stopMcp({ kernel: runtime.kernel })
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  300_000,
)
