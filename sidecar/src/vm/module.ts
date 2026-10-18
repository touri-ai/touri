import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import type { Kernel } from "@touri/contracts"
import { initCloud } from "../cloud/module"
import { routeVmRuntime } from "../cloud/runtime"
import type { PerformanceStageRunner } from "../kernel/performance"
import { machineCapability, ociEngine } from "../platform"
import { createOciProvider } from "../platform/oci-provider"
import { createAppleContainerProvider } from "./apple-container"
import { deleteBotRoute } from "./delete-bot"
import { createDesktopGateway } from "./desktop"
import { providerHosts, readEgressPolicy, saveEgressPolicy, validateEgressPolicy } from "./egress-policy"
import { machineActionRoutes } from "./machine-actions"
import {
  ProviderLoginError,
  providerLoginAccount,
  providerLoginSource,
  providerLoginSourceKey,
  readProviderLogin,
} from "./provider-login"
import { createProviderLoginFlow } from "./provider-login-flow"
import { createVmRuntime } from "./runtime"
import { botWorkspaceRoutes } from "./workspace-routes"

export const name = "vm"
export const init = async (kernel: Kernel, runStage?: PerformanceStageRunner): Promise<void> => {
  const loginFlow = createProviderLoginFlow({ kernel })
  kernel.registerRoutes({ name: "provider-login-flow", routes: loginFlow.routes })
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") loginFlow.dispose()
  })
  const engine = ociEngine()
  const provider =
    process.platform !== "darwin"
      ? createOciProvider({ engine: engine ?? "docker", dataDir: kernel.paths.appData })
      : createAppleContainerProvider({
          dataDir: kernel.paths.appData,
          warn: (code, detail) =>
            kernel.log({ level: "warn", module: "vm", msg: code, data: { detail: kernel.redact(detail) } }),
        })
  const capability = machineCapability()
  const runtime = createVmRuntime({ kernel, provider, capability, ...(runStage ? { runStage } : {}) })
  const cloud = initCloud(kernel)
  const service = routeVmRuntime(kernel, runtime.service, cloud.runtime)
  kernel.services.provide("vm.runtime", service)
  kernel.services.provide("vm.shutdown", runtime.dispose)
  const desktop = createDesktopGateway(kernel, service, runtime.paste, runStage)
  kernel.services.provide("vm.desktop", desktop.service)
  kernel.registerRoutes(desktop.routes)
  if (runtime.service.capability.available) {
    await runtime.sweepOrphans()
    await runtime.reconcile()
  }
  kernel.registerRoutes({
    name,
    routes: [
      {
        method: "GET",
        path: "/bots/:id/network-policy",
        handler: async ({ params }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (bot?.machine !== "vm") return { status: 404, json: { error: "Bot com VM não encontrado" } }
          return {
            status: 200,
            json: {
              requested: readEgressPolicy(kernel, bot.id),
              active: readEgressPolicy(kernel, bot.id, true),
              providerHosts: providerHosts(bot),
            },
          }
        },
      },
      {
        method: "PUT",
        path: "/bots/:id/network-policy",
        handler: async ({ params, body }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (bot?.machine !== "vm") return { status: 404, json: { error: "Bot com VM não encontrado" } }
          let policy: ReturnType<typeof validateEgressPolicy>
          try {
            policy = validateEgressPolicy(body)
          } catch {
            return { status: 400, json: { error: "Política de rede inválida" } }
          }
          saveEgressPolicy(kernel, bot.id, policy)
          try {
            await runtime.applyNetworkPolicy(bot.id)
          } catch {
            return { status: 503, json: { error: "A proteção de rede falhou; a máquina foi parada." } }
          }
          return {
            status: 200,
            json: {
              requested: policy,
              active: readEgressPolicy(kernel, bot.id, true),
              providerHosts: providerHosts(bot),
            },
          }
        },
      },
      {
        method: "GET",
        path: "/bots/:id/provider-login",
        handler: async ({ params }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (!bot) return { status: 404, json: { error: "Bot não encontrado" } }
          if (bot.machine === "cloud") return { status: 403, json: { errorCode: "TOURI-E9014" } }
          try {
            const login = await readProviderLogin(kernel, bot, homedir())
            return {
              status: 200,
              json: {
                provider: bot.provider,
                ready: true,
                source: login.source,
                configuredSource: providerLoginSource(kernel, bot),
                health: "ready",
                message: "Login disponível para este bot.",
              },
            }
          } catch (error) {
            return {
              status: 200,
              json: {
                provider: bot.provider,
                ready: false,
                source: "missing",
                configuredSource: providerLoginSource(kernel, bot),
                health: error instanceof ProviderLoginError ? error.reason : "invalid",
                message: error instanceof Error ? error.message : "Login ausente",
              },
            }
          }
        },
      },
      {
        method: "PUT",
        path: "/bots/:id/provider-login",
        handler: async ({ params, body }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (!bot) return { status: 404, json: { error: "Bot não encontrado" } }
          if (bot.machine === "cloud") return { status: 403, json: { errorCode: "TOURI-E9014" } }
          const source = (body as { source?: unknown })?.source
          if (source !== undefined && source !== "vault" && source !== "host-file")
            return { status: 400, json: { error: "Fonte de login inválida" } }
          const selectSource = (source: string) =>
            (kernel.db as Database)
              .query(
                "INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
              )
              .run(providerLoginSourceKey(bot), JSON.stringify(source), Date.now())
          if (source) {
            selectSource(source)
            return { status: 200, json: {} }
          }
          const value = (body as { value?: unknown })?.value
          if (typeof value !== "string" || !value.trim() || value.length > 20000)
            return { status: 400, json: { error: "Login inválido" } }
          if (bot.provider !== "claude") {
            try {
              JSON.parse(value)
            } catch {
              return {
                status: 400,
                json: { error: `Cole um auth.json válido do ${bot.provider === "opencode" ? "OpenCode" : "Codex"}` },
              }
            }
          }
          kernel.addRedactionValue(value)
          const result = await kernel.callHost("keychain.set", {
            account: providerLoginAccount(bot.id, bot.provider),
            value: value.trim(),
          })
          if (result.success) selectSource("vault")
          return result.success
            ? { status: 200, json: {} }
            : { status: 503, json: { error: "O cofre de segredos está indisponível" } }
        },
      },
      {
        method: "DELETE",
        path: "/bots/:id/provider-login",
        handler: async ({ params }) => {
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (!bot) return { status: 404, json: { error: "Bot não encontrado" } }
          if (bot.machine === "cloud") return { status: 403, json: { errorCode: "TOURI-E9014" } }
          const result = await kernel.callHost("keychain.delete", {
            account: providerLoginAccount(bot.id, bot.provider),
          })
          return result.success
            ? { status: 200, json: {} }
            : { status: 503, json: { error: "O cofre de segredos está indisponível" } }
        },
      },
      {
        method: "GET",
        path: "/machines",
        handler: async () => {
          if (engine && process.env.TOURI_HEADLESS !== "1") {
            const ready = await provider.startService()
            capability.available = ready.success
            capability.reason = ready.success ? null : ready.error
          }
          return { status: 200, json: { capability: runtime.service.capability, machines: service.states() } }
        },
      },
      ...machineActionRoutes(kernel, service),
      ...botWorkspaceRoutes(kernel, service),
      deleteBotRoute(kernel, service),
    ],
  })
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") void runtime.dispose()
  })
}
