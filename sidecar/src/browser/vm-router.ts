import type { Database } from "bun:sqlite"
import type { Kernel, MachineState, ToolResult } from "@touri/contracts"
import type { PerformanceStageRunner } from "../kernel/performance"
import { abortVmWait } from "../vm/stage"
import { connectCdpWebSocket } from "./cdp"
import { createBrowserEngine } from "./engine"
import { attachLocalChrome, type ChromeLauncher } from "./launcher"
import type { BrowserEngine, CdpClient } from "./types"
import { raceBudget } from "./utils"

// The guest engine reports page-level causes at its own budget; the router waits a little longer.
const ENGINE_BUDGET_SLACK_MS = 1500
const PROBE_BUDGET_MS = 1500

export const createRoutedBrowserEngine = (
  kernel: Kernel,
  mode: "system-chrome" | "chrome-for-testing",
  {
    guestTimeoutMs = 30_000,
    connect = connectCdpWebSocket,
    localLauncher = attachLocalChrome(),
    runStage,
  }: {
    guestTimeoutMs?: number
    connect?: typeof connectCdpWebSocket
    runStage?: PerformanceStageRunner
    localLauncher?: ChromeLauncher
  } = {},
): BrowserEngine => {
  const local = createBrowserEngine({ kernel, mode, ...(runStage ? { runStage } : {}) })
  const attached = createBrowserEngine({
    kernel,
    profile: "local",
    localBrowser: true,
    launcher: localLauncher,
    ...(runStage ? { runStage } : {}),
  })
  const hostForBot = (botId: string | null) =>
    botId && kernel.services.use("store.api")?.getBot({ botId })?.browser === "local" ? attached : local
  type Guest = {
    engine: BrowserEngine
    lifetime: AbortController
    failure: () => string | null
    alive: () => Promise<boolean>
  }
  const guests = new Map<string, Guest>()
  const machines = new Map<string, MachineState>()
  const emptyBrowser = (): ToolResult => ({
    success: true,
    content: [{ type: "text", text: "[]\nNavegador ainda não aberto. Use browser_open para abrir uma página na VM." }],
    structured: { tabs: [] },
  })
  const retire = (botId: string, guest: Guest | undefined, reason: Error) => {
    if (!guest) return
    if (guests.get(botId) === guest) guests.delete(botId)
    guest.lifetime.abort(reason)
    // Closing a stale transport must never hold up a new engine or a tool response.
    void guest.engine.shutdown().catch(() => undefined)
  }
  const botIdForTab = (tabId: string): string | null =>
    (
      (kernel.db as Database).query("SELECT owner_bot_id FROM browser_tabs WHERE id = ?").get(tabId) as {
        owner_bot_id: string
      } | null
    )?.owner_bot_id ?? null
  const isGuest = (botId: string | null): botId is string =>
    !!botId && kernel.services.use("store.api")?.getBot({ botId })?.browser === "machine"
  const forBot = (botId: string): Guest => {
    const existing = guests.get(botId)
    if (existing) return existing
    const lifetime = new AbortController()
    let client: CdpClient | null = null
    let pending: Promise<{ client: CdpClient } | null> | null = null
    let launchFailure: string | null = null
    const engine = createBrowserEngine({
      kernel,
      ...(runStage ? { runStage } : {}),
      profile: `vm:${botId}`,
      discoverBotId: botId,
      launcher: {
        start: async ({ runningOnly = false } = {}) => {
          lifetime.signal.throwIfAborted()
          if (client && !client.isClosed()) return { client }
          if (pending) return pending
          const vm = kernel.services.use("vm.runtime")
          if (!vm) return null
          pending = abortVmWait(lifetime.signal, async () => {
            const url = await vm.browserEndpoint({ botId, runningOnly, signal: lifetime.signal })
            lifetime.signal.throwIfAborted()
            if (!url) return null
            const transport = await connect({ url, signal: lifetime.signal })
            if (lifetime.signal.aborted) {
              void transport.close().catch(() => undefined)
              lifetime.signal.throwIfAborted()
            }
            transport.onDisconnect?.(() =>
              retire(botId, guest, new Error("A conexão com o navegador da VM foi encerrada.")),
            )
            client = {
              ...transport,
              call: (method, params, sessionId) =>
                abortVmWait(lifetime.signal, () => transport.call(method, params, sessionId)),
            }
            return { client }
          })
            .then((started) => {
              launchFailure = null
              return started
            })
            .catch((error: unknown) => {
              launchFailure = error instanceof Error ? error.message : null
              throw error
            })
            .finally(() => {
              pending = null
            })
          return pending
        },
        stop: async () => {
          lifetime.abort(new Error("A conexão com o navegador da VM foi reiniciada."))
          void client?.close().catch(() => undefined)
          client = null
        },
      },
    })
    const alive = async (): Promise<boolean> => {
      const current = client
      if (!current || current.isClosed()) return false
      const probe = await raceBudget({ work: current.call("Target.getTargets", {}), ms: PROBE_BUDGET_MS }).catch(
        () => ({
          timedOut: true as const,
        }),
      )
      return !probe.timedOut
    }
    const guest: Guest = { engine, lifetime, failure: () => launchFailure, alive }
    guests.set(botId, guest)
    return guest
  }
  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type === "bot.deleted" || event.type === "bot.updated") {
      const botId = event.type === "bot.deleted" ? event.botId : event.bot.id
      if (!isGuest(botId)) retire(botId, guests.get(botId), new Error("O navegador deste bot mudou."))
      return
    }
    if (event.type !== "machine.updated") return
    const machine = event.machine
    const previous = machines.get(machine.botId)
    machines.set(machine.botId, machine)
    // Warm readiness/progress and port updates are not boots. Authentication rotates on every boot.
    if (
      machine.status !== "running" ||
      previous?.status !== "running" ||
      previous.connection?.authKeyId !== machine.connection?.authKeyId ||
      previous.connection?.machineId !== machine.connection?.machineId
    )
      retire(
        machine.botId,
        guests.get(machine.botId),
        new Error("A máquina foi reiniciada. Tente abrir o navegador novamente."),
      )
  })
  // Every operation resolves its bot before reaching a launcher; there is no VM-to-host fallback.
  return new Proxy(local, {
    get(_target, key: keyof BrowserEngine) {
      if (key === "shutdown")
        return async () => {
          unsubscribe()
          for (const [botId, guest] of guests) retire(botId, guest, new Error("Navegador encerrado."))
          await Promise.all([local.shutdown(), attached.shutdown()])
        }
      if (key === "tabsForBot")
        return (botId: string | null) => {
          if (botId) return (isGuest(botId) ? forBot(botId).engine : hostForBot(botId)).tabsForBot(botId)
          // Restore guest tab metadata for the workspace snapshot without booting a VM.
          const owners = (kernel.db as Database)
            .query("SELECT DISTINCT owner_bot_id FROM browser_tabs WHERE profile LIKE 'vm:%' AND state != 'closed'")
            .all() as Array<{ owner_bot_id: string }>
          for (const owner of owners) if (isGuest(owner.owner_bot_id)) forBot(owner.owner_bot_id)
          return [local, attached, ...[...guests.values()].map(({ engine }) => engine)].flatMap((engine) =>
            engine
              .tabsForBot(null)
              .filter(
                (tab) =>
                  tab.ownerBotId &&
                  (isGuest(tab.ownerBotId) ? guests.get(tab.ownerBotId)?.engine : hostForBot(tab.ownerBotId)) ===
                    engine,
              ),
          )
        }
      return (input: unknown) => {
        const args =
          typeof input === "object" && input
            ? (input as {
                botId?: string
                ctx?: { botId: string; signal?: AbortSignal }
                tabId?: string
                signal?: AbortSignal
                timeoutMs?: number
              })
            : {}
        const botId =
          args.ctx?.botId ??
          args.botId ??
          (args.tabId ? botIdForTab(args.tabId) : typeof input === "string" ? botIdForTab(input) : null)
        if (key === "preview" && isGuest(botId)) return Promise.resolve(null)
        if (isGuest(botId))
          return (async () => {
            const vm = kernel.services.use("vm.runtime")
            if (
              key === "list" &&
              !vm?.states().some((machine) => machine.botId === botId && machine.status === "running")
            )
              return emptyBrowser()
            const controller = new AbortController()
            const signal = args.ctx?.signal ?? args.signal
            const cancel = () => controller.abort(new Error("Operação do navegador da VM cancelada."))
            signal?.addEventListener("abort", cancel, { once: true })
            if (signal?.aborted) cancel()
            // Human takeover has an explicit wait budget of up to 30 minutes.
            const maximum = key === "requestTakeover" ? 1_800_000 : guestTimeoutMs
            const requested = args.timeoutMs === undefined ? guestTimeoutMs : args.timeoutMs + ENGINE_BUDGET_SLACK_MS
            const timeoutMs = Math.max(1, Math.min(maximum, requested))
            const timer = setTimeout(
              () =>
                controller.abort(
                  new Error(
                    `O navegador da VM não respondeu em ${timeoutMs / 1000} s. Tente novamente para reconectar o navegador.`,
                  ),
                ),
              timeoutMs,
            )
            let guest = guests.get(botId)
            try {
              return await abortVmWait(controller.signal, async () => {
                if (!vm) throw new Error("VM indisponível")
                const release = await vm.acquire({
                  botId,
                  signal: controller.signal,
                  ...(key === "list" ? { runningOnly: true } : {}),
                })
                try {
                  controller.signal.throwIfAborted()
                  // Acquisition can recreate or boot the VM and invalidate its old engine.
                  guest = forBot(botId)
                  const result = await (guest.engine[key] as (value: unknown) => unknown)(input)
                  if (typeof result === "object" && result && "success" in result && !result.success) {
                    const failure = result as Extract<ToolResult, { success: false }>
                    const transportFailure =
                      failure.errorCode === "DEADLINE_EXCEEDED" || failure.errorCode === "ENGINE_UNAVAILABLE"
                    const cause = transportFailure ? guest.failure() : null
                    if (transportFailure && !cause && (await guest.alive())) return failure
                    if (transportFailure) {
                      retire(botId, guest, new Error("Navegador da VM indisponível."))
                      if (cause)
                        return {
                          success: false,
                          errorCode: "BROWSER_START_FAILED",
                          error: kernel.redact(cause),
                        }
                      return {
                        ...failure,
                        error:
                          failure.errorCode === "DEADLINE_EXCEEDED"
                            ? "O navegador da VM não respondeu no prazo. Tente novamente para reconectar o navegador."
                            : "Não foi possível conectar ao navegador da VM. Tente novamente para reconectar o navegador.",
                      }
                    }
                  }
                  return result
                } finally {
                  await release()
                }
              })
            } catch (error) {
              const reason = controller.signal.aborted ? controller.signal.reason : error
              const message =
                reason instanceof Error ? reason.message : "Navegador da VM indisponível. Tente novamente."
              retire(botId, guest, new Error(message))
              if (key === "list" && message === "A máquina não está em execução") return emptyBrowser()
              if (key === "getWindowBounds") return null
              if (key === "releaseTakeover" || key === "holdTakeover") return false
              return {
                success: false,
                errorCode: controller.signal.aborted ? "DEADLINE_EXCEEDED" : "ENGINE_UNAVAILABLE",
                error: `Não foi possível concluir a operação no navegador da VM: ${kernel.redact(message)}`,
              }
            } finally {
              clearTimeout(timer)
              signal?.removeEventListener("abort", cancel)
            }
          })()
        return (hostForBot(botId)[key] as (value: unknown) => unknown)(input)
      }
    },
  })
}
