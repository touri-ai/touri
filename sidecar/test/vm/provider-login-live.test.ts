import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, ProviderLoginFlow, Run } from "@touri/contracts"
import { createHeadlessHost } from "../../src/cli/host/headlessHost"
import { createSecretStore } from "../../src/cli/host/secretStore"
import { createKernel } from "../../src/kernel"
import { initModules } from "../../src/main"
import { appleContainerAvailable } from "./integration-available"

// Explicit opt-in: this uses the user's provider quota, never reads production data,
// and destroys only the machines/data created by this test.
test.skipIf(process.env.TOURI_VM_LOGIN_E2E !== "1" || !appleContainerAvailable)(
  "real Claude and Codex VM bots answer with vault logins after cancellation",
  async () => {
    for (const provider of ["claude", "codex"] as const) {
      const value = process.env[provider === "claude" ? "TOURI_TEST_CLAUDE_TOKEN" : "TOURI_TEST_CODEX_AUTH"]
      if (!value) throw new Error(`Missing test login for ${provider}`)
      const root = mkdtempSync(join(tmpdir(), "touri-login-live-"))
      const secrets = createSecretStore({ dir: root })
      const runtime = createKernel({
        appData: root,
        web: {
          hostname: "127.0.0.1",
          port: 0,
          intercept: async () => null,
          host: createHeadlessHost({ secrets }),
        },
      })
      let bot: Bot | undefined
      const request = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
        const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        })
        expect(response.ok).toBe(true)
        return response.json() as Promise<T>
      }
      try {
        await initModules(runtime)
        ;({ bot } = await request<{ bot: Bot }>("/bots", "POST", {
          name: `Login VM ${provider}`,
          provider,
          machine: "vm",
          vmProviderLogin: true,
          instructions: "Responda em português, em uma linha. Não use ferramentas.",
        }))
        const path = `/bots/${bot.id}/provider-login/flow`
        expect((await request<ProviderLoginFlow>(path, "POST", { provider, action: "paste", value })).state).toBe(
          "ready",
        )
        // Cancel while shell discovery is pending: no browser or second account is opened.
        const shellEnv = runtime.kernel.shellEnv
        let releaseDiscovery: (() => void) | undefined
        runtime.kernel.shellEnv = async () => {
          await new Promise<void>((resolve) => {
            releaseDiscovery = resolve
          })
          return shellEnv()
        }
        try {
          expect((await request<ProviderLoginFlow>(path, "POST", { provider, action: "start" })).state).toBe("waiting")
          expect((await request<ProviderLoginFlow>(path, "POST", { provider, action: "cancel" })).state).toBe(
            "cancelled",
          )
        } finally {
          runtime.kernel.shellEnv = shellEnv
          releaseDiscovery?.()
        }
        expect((await request<ProviderLoginFlow>(`${path}?provider=${provider}`)).state).toBe("ready")
        const threadId = bot.mainThreadId
        if (!threadId) throw new Error("Missing conversation")
        await request(`/threads/${threadId}/messages`, "POST", {
          text: "Responda somente: VM_LOGIN_OK. Não use ferramentas.",
          parentId: null,
          attachmentIds: [],
        })
        let run: Run | undefined
        for (let attempt = 0; attempt < 360; attempt++) {
          ;({
            runs: [run],
          } = await request<{ runs: Run[] }>(`/threads/${threadId}/runs`))
          if (run && ["succeeded", "failed", "canceled"].includes(run.status)) break
          await Bun.sleep(500)
        }
        expect(run?.status).toBe("succeeded")
        const messages = runtime.kernel.services.use("store.api")?.activePath({ threadId })
        expect(JSON.stringify(messages?.filter((message) => message.role === "assistant"))).toContain("VM_LOGIN_OK")
        const guest = await runtime.kernel.services
          .use("vm.runtime")
          ?.exec({ botId: bot.id, command: "uname", args: ["-s"] })
        expect(guest?.success && guest.stdout.trim()).toBe("Linux")
        console.info(`[VM login] ${provider}: vault -> cancelled -> ready -> Linux reply VM_LOGIN_OK`)
      } finally {
        await runtime.kernel.services.use("runtime.shutdown")?.()
        if (bot) await runtime.kernel.services.use("vm.runtime")?.destroy({ botId: bot.id })
        runtime.emitHostNotification({ method: "app.willQuit", params: {} })
        await runtime.kernel.services.use("vm.shutdown")?.()
        runtime.stop()
        rmSync(root, { recursive: true, force: true })
      }
    }
  },
  420_000,
)
