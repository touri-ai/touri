import type {
  Id,
  Kernel,
  RouteModule,
  RouteResponse,
  TelegramIntegration,
  TelegramIntegrationStatus,
} from "@touri/contracts"
import { createTelegramBridge, type TelegramBridge } from "./bridge"
import { createTelegramStore, normalizeConfig, tokenAccount } from "./store"

const OFF: TelegramIntegrationStatus = { state: "off", username: null, error: null }
const TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,100}$/

const fail = (status: number, errorCode: string, error: string): RouteResponse => ({
  status,
  json: { errorCode, error },
})

/** Starts one bridge per enabled bot and serves the configuration routes. */
export const createTelegramIntegrations = ({
  kernel,
  apiBase,
  pollTimeoutSec,
}: {
  kernel: Kernel
  apiBase?: string
  pollTimeoutSec?: number
}) => {
  const store = createTelegramStore(kernel)
  const bridges = new Map<Id, TelegramBridge>()
  const statuses = new Map<Id, TelegramIntegrationStatus>()
  // Serializes restarts per bot so a quick toggle never leaves two pollers on one token.
  const pending = new Map<Id, Promise<void>>()
  let stopping = false
  const serialize = <T>(botId: Id, task: () => Promise<T>): Promise<T> => {
    const result = (pending.get(botId) ?? Promise.resolve()).then(task)
    const settled = result.then(
      () => undefined,
      () => undefined,
    )
    pending.set(botId, settled)
    void settled.then(() => {
      if (pending.get(botId) === settled) pending.delete(botId)
    })
    return result
  }

  const readToken = async (botId: Id): Promise<string | null> => {
    const saved = await kernel.callHost("keychain.get", { account: tokenAccount(botId) })
    const token = saved.success ? saved.value.value : null
    if (token) kernel.addRedactionValue(token)
    return token
  }

  const stop = async (botId: Id): Promise<void> => {
    const bridge = bridges.get(botId)
    bridges.delete(botId)
    statuses.set(botId, OFF)
    await bridge?.stop()
  }

  const restart = async (botId: Id): Promise<void> => {
    await stop(botId)
    if (stopping || !store.config(botId).enabled || !kernel.services.use("store.api")?.getBot({ botId })) return
    const token = await readToken(botId)
    if (stopping || !kernel.services.use("store.api")?.getBot({ botId })) return
    if (!token) {
      statuses.set(botId, { state: "error", username: null, error: "Salve o token do bot do Telegram." })
      return
    }
    const bridge = createTelegramBridge({
      kernel,
      botId,
      token,
      store,
      ...(apiBase ? { apiBase } : {}),
      ...(pollTimeoutSec === undefined ? {} : { pollTimeoutSec }),
      onStatus: (status) => {
        if (bridges.get(botId) === bridge) statuses.set(botId, status)
      },
    })
    bridges.set(botId, bridge)
    bridge.start()
  }

  const describe = async (botId: Id): Promise<TelegramIntegration> => {
    const saved = await kernel.callHost("keychain.get", { account: tokenAccount(botId) })
    return {
      config: store.config(botId),
      tokenSaved: saved.success && !!saved.value.value,
      status: statuses.get(botId) ?? OFF,
      lastRejected: store.state(botId).lastRejected,
    }
  }

  const update = async (botId: Id, body: unknown): Promise<RouteResponse> => {
    if (stopping) return fail(503, "UNAVAILABLE", "A integração está sendo desligada.")
    if (!kernel.services.use("store.api")?.getBot({ botId })) return fail(404, "NOT_FOUND", "Bot não encontrado")
    const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
    if (input.token !== undefined && input.token !== null && typeof input.token !== "string")
      return fail(400, "INVALID_ARGS", "token must be a string or null")
    const token = typeof input.token === "string" ? input.token.trim() : input.token
    if (typeof token === "string" && !TOKEN.test(token))
      return fail(400, "INVALID_ARGS", "O token não parece um token do BotFather.")
    if (token !== undefined) {
      const previous = await kernel.callHost("keychain.get", { account: tokenAccount(botId) })
      if (!previous.success) return fail(500, "SECRET_UNAVAILABLE", "Não foi possível ler o token salvo.")
      await stop(botId)
      if (typeof token === "string") kernel.addRedactionValue(token)
      const saved =
        typeof token === "string"
          ? await kernel.callHost("keychain.set", { account: tokenAccount(botId), value: token })
          : await kernel.callHost("keychain.delete", { account: tokenAccount(botId) })
      if (!saved.success) {
        await restart(botId)
        return fail(500, "SECRET_UNAVAILABLE", "Não foi possível salvar o token.")
      }
      // A different account has its own update IDs and must never inherit another account's chats.
      if (previous.value.value !== token) store.resetState(botId)
    }
    const current = store.config(botId)
    const next = normalizeConfig({
      ...current,
      ...Object.fromEntries(
        ["enabled", "allowedUserIds", "homeChatId", "forwardRoutines"]
          .filter((key) => input[key] !== undefined)
          .map((key) => [key, input[key]]),
      ),
    })
    store.saveConfig(botId, next)
    // A changed allowlist or toggle applies on the next update; only the token or switch needs a reconnect.
    if (
      token !== undefined ||
      next.enabled !== current.enabled ||
      (next.enabled && (!bridges.has(botId) || statuses.get(botId)?.state === "error"))
    )
      await restart(botId)
    return { status: 200, json: { telegram: await describe(botId) } }
  }

  const routes: RouteModule = {
    name: "telegram",
    routes: [
      {
        method: "GET",
        path: "/bots/:id/integrations/telegram",
        handler: async ({ params }) => {
          const botId = params.id ?? ""
          if (!kernel.services.use("store.api")?.getBot({ botId })) return fail(404, "NOT_FOUND", "Bot não encontrado")
          return { status: 200, json: { telegram: await describe(botId) } }
        },
      },
      {
        method: "PUT",
        path: "/bots/:id/integrations/telegram",
        handler: async ({ params, body }) => serialize(params.id ?? "", () => update(params.id ?? "", body)),
      },
    ],
  }

  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type !== "bot.deleted") return
    void serialize(event.botId, async () => {
      await stop(event.botId)
      store.remove(event.botId)
      statuses.delete(event.botId)
      await kernel.callHost("keychain.delete", { account: tokenAccount(event.botId) })
    }).catch((error) =>
      kernel.log({
        level: "error",
        module: "telegram",
        msg: "Falha ao remover integração",
        data: { error: kernel.redact(String(error)) },
      }),
    )
  })

  return {
    routes,
    start: async (): Promise<void> => {
      await Promise.all(store.configuredBots().map((botId) => serialize(botId, () => restart(botId))))
    },
    stopAll: async (): Promise<void> => {
      stopping = true
      unsubscribe()
      await Promise.all([...bridges.keys()].map((botId) => stop(botId)))
      await Promise.all([...pending.values()])
      await Promise.all([...bridges.keys()].map((botId) => stop(botId)))
    },
    status: (botId: Id) => statuses.get(botId) ?? OFF,
  }
}

export const name = "telegram"

export const init = async (kernel: Kernel): Promise<void> => {
  const integrations = createTelegramIntegrations({ kernel })
  kernel.registerRoutes(integrations.routes)
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") void integrations.stopAll()
  })
  // Bridges connect in the background so a slow network never delays startup.
  void integrations.start().catch((error) =>
    kernel.log({
      level: "error",
      module: "telegram",
      msg: "Falha ao iniciar o Telegram",
      data: { error: kernel.redact(String(error)) },
    }),
  )
}
