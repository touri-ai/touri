import type { Database } from "bun:sqlite"
import type {
  CloudAccount,
  CloudAccountState,
  CloudAuthorization,
  CloudEvent,
  CloudMachine,
  CloudOperation,
  CloudPlan,
  CloudService,
  CloudTokens,
  CloudUsage,
  Kernel,
  MachineState,
  Message,
  Run,
} from "@touri/contracts"
import { createRemoteProvider } from "../vm/remote"
import { CloudError, createCloudClient } from "./client"
import { cloudBotConfig, createCloudRuntime } from "./runtime"

type Mapping = { machine_id: string; generation: number; base_url: string; account_id: string }
export const initCloud = (kernel: Kernel) => {
  const client = createCloudClient(kernel)
  const provider = createRemoteProvider({ client })
  const db = kernel.db as Database
  let pairing: CloudAuthorization | null = null
  let lastPoll = 0
  let stream: WebSocket | null = null
  let connecting = false
  let cursor = "0"
  let disposed = false
  let retry: ReturnType<typeof setTimeout> | undefined
  const enabled = () => kernel.services.use("store.settings")?.().cloud === true
  const account = () => client.request<CloudAccount>("GET", "/v1/account")
  const mapping = async (botId: string) => {
    const value = db.query("SELECT * FROM cloud_machines WHERE bot_id = ?").get(botId) as Mapping | null
    if (!value || value.base_url !== client.base().origin || value.account_id !== (await account()).id)
      throw new CloudError("TOURI-E9003")
    return value
  }
  const remember = (value: CloudMachine): MachineState => {
    db.query("UPDATE cloud_machines SET generation = ? WHERE bot_id = ?").run(value.generation, value.botId)
    return remote.remember({
      botId: value.botId,
      status:
        value.state === "running"
          ? "running"
          : ["waking", "provisioning", "parking"].includes(value.state)
            ? "starting"
            : value.state === "error"
              ? "error"
              : "stopped",
      progress: value.progress,
      error: value.state === "error" ? "O computador na nuvem precisa de atenção." : null,
      memoryMb: 2048,
      createdMs: null,
      startMs: null,
      cloud: { state: value.state, generation: value.generation, usage: value.usage },
    })
  }
  const machine = async (botId: string) => {
    const value = await mapping(botId)
    return remember(await provider.machine(value.machine_id))
  }
  const action = async (botId: string, verb: string) => {
    const value = await mapping(botId)
    const prior = await provider.machine(value.machine_id)
    if (verb === "wake" && prior.state === "running") return remember(prior)
    remember({
      ...prior,
      state: verb === "wake" ? "waking" : "parking",
      progress: verb === "wake" ? "Acordando o computador na nuvem…" : "Hibernando o computador…",
    })
    try {
      return remember(await provider.lifecycle(value.machine_id, verb))
    } catch (error) {
      await machine(botId).catch(() => undefined)
      throw error
    }
  }
  const remote = createCloudRuntime(kernel, provider, {
    machine,
    id: async (id) => (await mapping(id)).machine_id,
    wake: (id) => action(id, "wake"),
    park: (id) => action(id, "park"),
  })
  const closeStreams = () => {
    stream?.close()
    stream = null
    clearTimeout(retry)
    provider.disconnect()
  }
  const watch = async () => {
    if (disposed || !enabled() || stream || connecting) return
    connecting = true
    try {
      if (!(await client.load())) return
      if ((await client.capabilities()).implementation?.gatewayReady === false) return
      stream = await client.socket(
        client.endpoint(`/v1/events?since=${encodeURIComponent(cursor)}`).replace(/^http/, "ws"),
      )
      const current = stream
      current.addEventListener("message", ({ data }) => {
        try {
          const frame = JSON.parse(String(data)) as CloudEvent
          if ("resync" in frame) {
            cursor = frame.cursor
            kernel.publish({ type: "transcript.resync" })
            return
          }
          const record = db.query("SELECT * FROM cloud_machines WHERE bot_id = ?").get(frame.botId) as Mapping | null
          if (
            !record ||
            record.base_url !== client.base().origin ||
            !Number.isSafeInteger(frame.generation) ||
            frame.generation < record.generation
          )
            return
          cursor = frame.cursor
          if (frame.event.type === "machine.updated") {
            if (frame.event.machine.botId !== frame.botId || !frame.event.machine.cloud) return
            remote.remember({ ...frame.event.machine, connection: null })
            db.query("UPDATE cloud_machines SET generation = ? WHERE bot_id = ?").run(frame.generation, frame.botId)
            provider.disconnect(record.machine_id)
          } else if (
            [
              "message.created",
              "message.updated",
              "message.delta",
              "message.parts",
              "run.updated",
              "thread.updated",
              "approval.requested",
              "approval.resolved",
            ].includes(frame.event.type)
          )
            kernel.publish(JSON.parse(kernel.redact(JSON.stringify(frame.event))))
        } catch {
          current.close(1008)
        }
      })
      current.addEventListener("close", (event) => {
        if (event.code === 1008) {
          if (stream === current) stream = null
          client.forget()
          provider.disconnect()
          return
        }
        if (stream === current) stream = null
        if (!disposed && enabled()) {
          retry = setTimeout(() => void watch(), 5000)
          retry.unref()
        }
      })
    } finally {
      connecting = false
    }
  }
  const state = async (): Promise<CloudAccountState> => {
    const empty = {
      enabled: enabled(),
      connected: false,
      account: null,
      plan: null,
      usage: null,
      pairing: pairing
        ? {
            userCode: pairing.userCode,
            verificationUri: pairing.verificationUri,
            expiresAt: pairing.expiresAt,
            intervalSeconds: pairing.intervalSeconds,
          }
        : null,
    }
    if (!enabled()) {
      closeStreams()
      return empty
    }
    if (!kernel.services.use("store.settings")?.().cloudBaseUrl) return empty
    if (!(await client.load())) return empty
    const capabilities = await client.capabilities()
    const [identity, plan, usage] = await Promise.all([
      account(),
      client.request<CloudPlan>("GET", "/v1/plan"),
      client.request<CloudUsage>("GET", "/v1/usage"),
    ])
    client.endpoint(plan.subscribeUrl)
    if (
      plan.sandbox !== true ||
      !Number.isSafeInteger(plan.priceCentavos) ||
      plan.priceCentavos <= 0 ||
      plan.currency !== "BRL"
    )
      throw new CloudError("TOURI-E9014")
    plan.subscribeUrl = client.webEndpoint("/conta")
    const runtimeAvailable =
      capabilities.implementation?.headlessRuntimeReady !== false &&
      capabilities.capabilities.includes("exec") &&
      capabilities.capabilities.includes("desktop")
    if (runtimeAvailable) void watch().catch(() => undefined)
    return { ...empty, connected: true, account: identity, plan, usage, runtimeAvailable }
  }
  const service: CloudService = {
    uploadReport: client.uploadReport,
    state,
    connected: async () => (await state()).connected,
    request: client.request,
    machine,
    createBot: async (bot, apiKey) => {
      await client.capabilities()
      if (!apiKey?.trim() || apiKey.length > 20_000) throw new CloudError("TOURI-E9014")
      kernel.addRedactionValue(apiKey)
      const identity = await account()
      await client.request("POST", "/v1/bots", cloudBotConfig(bot), undefined, bot.id)
      try {
        await client.request("PUT", `/v1/bots/${encodeURIComponent(bot.id)}/key`, { provider: bot.provider, apiKey })
        const value = await provider.wait(
          await client.request<CloudOperation>("POST", "/v1/machines", {
            botId: bot.id,
            size: "small",
            imageVersion: (await client.capabilities()).imageVersions[0],
          }),
        )
        db.query(
          "INSERT INTO cloud_machines(bot_id, base_url, account_id, machine_id, generation) VALUES (?, ?, ?, ?, ?)",
        ).run(bot.id, client.base().origin, identity.id, value.id, value.generation)
        remember(value)
        void watch().catch(() => undefined)
      } catch (error) {
        await client
          .request("DELETE", `/v1/bots/${encodeURIComponent(bot.id)}`, { confirm: true })
          .catch(() => undefined)
        throw error
      }
    },
    send: async (input) => {
      const thread = kernel.services.use("store.api")?.getThread({ threadId: input.threadId })
      if (!input.clientNonce) throw new CloudError("TOURI-E9007")
      if (!thread || input.attachmentIds.length) throw new CloudError("TOURI-E9009")
      await mapping(thread.botId)
      const response = await client.request<{ message: Message; run: Run }>(
        "POST",
        `/v1/bots/${encodeURIComponent(thread.botId)}/messages`,
        input,
        undefined,
        input.clientNonce,
      )
      db.query("INSERT OR IGNORE INTO cloud_runs(run_id, bot_id) VALUES (?, ?)").run(response.run.id, thread.botId)
      return response
    },
    park: (id) => action(id, "park"),
    wake: (id) => action(id, "wake"),
  }
  kernel.services.provide("cloud.settingsChanged", () => {
    closeStreams()
    pairing = null
    cursor = "0"
    client.forget()
    if (enabled()) void state().catch(() => undefined)
  })
  kernel.services.provide("cloud.account", service)
  kernel.registerRoutes({
    name: "cloud",
    routes: [
      { method: "GET", path: "/cloud/account", handler: async () => ({ status: 200, json: await state() }) },
      {
        method: "POST",
        path: "/cloud/pair",
        handler: async () => {
          await client.capabilities()
          if (await client.load()) throw new CloudError("TOURI-E9005")
          const result = await client.raw<CloudAuthorization>("POST", "/v1/device/authorizations", {
            deviceName: "touri desktop",
          })
          client.endpoint(result.verificationUri)
          if (
            !result.deviceCode ||
            !result.userCode ||
            result.intervalSeconds < 5 ||
            !Number.isFinite(Date.parse(result.expiresAt)) ||
            Date.parse(result.expiresAt) <= Date.now() ||
            Date.parse(result.expiresAt) > Date.now() + 600_000
          )
            throw new CloudError("TOURI-E9007")
          kernel.addRedactionValue(result.deviceCode)
          pairing = { ...result, verificationUri: client.webEndpoint("/parear", result.userCode) }
          lastPoll = Date.now()
          return { status: 200, json: (await state()).pairing }
        },
      },
      {
        method: "POST",
        path: "/cloud/pair/poll",
        handler: async () => {
          if (!pairing || Date.parse(pairing.expiresAt) <= Date.now()) {
            pairing = null
            throw new CloudError("TOURI-E9011")
          }
          if (Date.now() - lastPoll < pairing.intervalSeconds * 1000) return { status: 200, json: await state() }
          lastPoll = Date.now()
          try {
            await client.store(
              await client.raw<CloudTokens>("POST", "/v1/device/token", { deviceCode: pairing.deviceCode }),
            )
            pairing = null
          } catch (error) {
            if (!(error instanceof CloudError) || error.code !== "TOURI-E9010") {
              if (error instanceof CloudError && ["TOURI-E9011", "TOURI-E9001"].includes(error.code)) pairing = null
              throw error
            }
          }
          return { status: 200, json: await state() }
        },
      },
      {
        method: "DELETE",
        path: "/cloud/account",
        handler: async () => {
          closeStreams()
          await client.unpair()
          pairing = null
          cursor = "0"
          return { status: 200, json: {} }
        },
      },
      ...(["park", "wake"] as const).map((verb) => ({
        method: "POST" as const,
        path: `/cloud/bots/:id/${verb}`,
        handler: async ({ params }: import("@touri/contracts").RouteRequest) => ({
          status: 200,
          json: { machine: await service[verb](params.id ?? "") },
        }),
      })),
      {
        method: "PUT",
        path: "/cloud/bots/:id/key",
        handler: async ({ params, body }) => {
          const apiKey = (body as { apiKey?: unknown })?.apiKey
          const bot = kernel.services.use("store.api")?.getBot({ botId: params.id ?? "" })
          if (bot?.machine !== "cloud" || typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 20_000)
            throw new CloudError("TOURI-E9014")
          await mapping(bot.id)
          kernel.addRedactionValue(apiKey)
          await client.request("PUT", `/v1/bots/${encodeURIComponent(bot.id)}/key`, { provider: bot.provider, apiKey })
          return { status: 200, json: {} }
        },
      },
    ],
  })
  kernel.onHostNotification(({ method }) => {
    if (method === "app.willQuit") {
      disposed = true
      closeStreams()
      remote.dispose()
    }
  })
  kernel.subscribe(({ event }) => {
    if (event.type === "bot.updated" && event.bot.machine === "cloud" && !event.bot.archivedAt)
      void client
        .request("PATCH", `/v1/bots/${encodeURIComponent(event.bot.id)}`, cloudBotConfig(event.bot))
        .catch(() => undefined)
  })
  if (enabled() && kernel.services.use("store.settings")?.().cloudBaseUrl)
    void state()
      .then(async (value) => {
        if (!value.connected) return
        const rows = db
          .query("SELECT bot_id FROM cloud_machines WHERE base_url = ? AND account_id = ?")
          .all(client.base().origin, value.account?.id ?? "") as Array<{ bot_id: string }>
        for (const row of rows) await machine(row.bot_id).catch(() => undefined)
      })
      .catch(() => undefined)
  return {
    runtime: remote.service,
    provider,
    service,
    dispose: () => {
      disposed = true
      closeStreams()
    },
  }
}
