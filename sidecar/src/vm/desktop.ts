import { randomBytes } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import type { DesktopSocket, Kernel, RouteModule, VmDesktop, VmRuntime } from "@touri/contracts"
import { createBackgroundTask, getMeasuredStage, yieldBackground } from "../kernel/background-task"
import { type DeviceSession, deviceSession, socketDeviceContext } from "../kernel/device-session"
import type { PerformanceStageRunner } from "../kernel/performance"
import clipboard from "./clipboard.py" with { type: "text" }
import { DesktopInputGate } from "./desktop-protocol"
import { VncAuthenticator } from "./vnc-auth"

type Session = {
  device?: DeviceSession | undefined
  preview: boolean
  frameTimer?: ReturnType<typeof setTimeout> | undefined
  frameRequest?: Buffer | undefined
  lastFrameAt?: number
  botId: string
  control: boolean
  claimed: boolean
  release: () => Promise<void>
  path?: string
  port: number
  password: string
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
  gate: DesktopInputGate
  guest?: Socket
  auth?: VncAuthenticator
  inputAbort?: AbortController
  inputSettled?: Promise<void>
  viewer?: DesktopSocket
}

export const createDesktopGateway = (
  kernel: Kernel,
  vm: VmRuntime,
  paste?: (input: { botId: string; text: string; signal: AbortSignal }) => Promise<void>,
  runStage?: PerformanceStageRunner,
) => {
  const sessions = new Map<string, Session>()
  const closing = new Map<string, { botId: string; settled: Promise<void> }>()
  const pending = new Map<AbortController, { control: boolean; botId: string; settled: Promise<void> }>()
  const drain = (botId: string) =>
    Promise.all([...closing.values()].filter((session) => session.botId === botId).map((session) => session.settled))
  const targetEpochs = new Map<string, number>()
  const changeTarget = (botId: string) => {
    const next = (targetEpochs.get(botId) ?? 0) + 1
    targetEpochs.set(botId, next)
    return next
  }
  let epoch = 0
  let disposed = false
  const revocation = createBackgroundTask(
    "desktop_revocation",
    async () => {
      const measure = getMeasuredStage("desktop_revocation", runStage)
      let scanned = 0
      for (const [id, session] of sessions) {
        if (disposed) return

        measure(() => {
          if (session.device && !session.device.active()) void close(id, "device revoked")
        })
        scanned += 1
        if (scanned % 50 === 0) await yieldBackground()
      }
    },
    runStage,
  )
  const revocationTimer = setInterval(() => {
    void revocation.run().catch(() => undefined)
  }, 250)
  revocationTimer.unref()
  const botFor = (botId: string) => kernel.services.use("store.api")?.getBot({ botId })
  const log = (decision: string, data: Record<string, unknown>) =>
    kernel.log({ level: "info", module: "vm.desktop", msg: decision, data })
  const close = (id: string, reason = "viewer closed", closeCode?: number): Promise<void> => {
    const session = sessions.get(id)
    if (!session) return closing.get(id)?.settled ?? Promise.resolve()
    log("Desktop session closed", { botId: session.botId, control: session.control, reason, closeCode, epoch })
    session.control = false
    sessions.delete(id)
    clearTimeout(session.timer)
    session.inputAbort?.abort()
    clearTimeout(session.frameTimer)
    session.viewer?.close(1000, "Conexão da tela encerrada")
    if (session.guest && !session.guest.destroyed) {
      session.guest.end(session.auth?.authenticated ? session.gate.releases() : Buffer.alloc(0))
      const guest = session.guest
      setTimeout(() => guest.destroy(), 200).unref()
    }
    const settled = Promise.all([session.release().catch(() => undefined), session.inputSettled]).then(() => {
      closing.delete(id)
    })
    closing.set(id, { botId: session.botId, settled })
    return settled
  }
  const revokeControl = (): void => {
    epoch += 1
    log("Desktop control revoked", { epoch, pending: pending.size, sessions: sessions.size })
    for (const [controller, request] of pending) if (request.control) controller.abort()
    for (const [id, session] of sessions) if (session.control) close(id, "control revoked")
  }
  const valid = (session: Session): boolean => {
    const bot = botFor(session.botId)
    return (
      (!session.device || session.device.active()) &&
      (bot?.machine === "vm" || bot?.machine === "cloud") &&
      (!session.control || bot?.machine === "vm")
    )
  }
  const unsubscribe = kernel.subscribe(({ event }) => {
    if (event.type === "bot.updated" || event.type === "machine.updated") {
      for (const [id, session] of sessions)
        if (
          !valid(session) ||
          (event.type === "machine.updated" &&
            event.machine.botId === session.botId &&
            event.machine.status !== "running")
        )
          close(id, event.type === "machine.updated" ? `machine ${event.machine.status}` : "permission changed")
    }
  })
  const unhost = kernel.onHostNotification(({ method }) => {
    if (method === "computer.killSwitch") revokeControl()
    if (method === "app.willQuit") service.dispose()
  })
  const service: VmDesktop = {
    claim: (id) => {
      const session = sessions.get(id)
      if (!session || session.claimed) return false
      if (
        session.device &&
        (session.device.deviceId !== socketDeviceContext.getStore()?.deviceId || !session.device.active())
      )
        return false
      if (!valid(session) || Date.now() >= session.expiresAt) {
        close(id)
        return false
      }
      session.claimed = true
      log("Desktop session claimed", { botId: session.botId, control: session.control, epoch })
      return true
    },
    open: (id, viewer) => {
      const session = sessions.get(id)
      if (!session?.claimed || !valid(session) || (session.device && !session.device.active())) {
        viewer.close(1008, "Conexão da tela expirada")
        close(id)
        return
      }
      clearTimeout(session.timer)
      session.viewer = viewer
      session.gate = new DesktopInputGate(
        (phase) => {
          if (viewer.send(phase === "version" ? Buffer.from([1, 1]) : Buffer.alloc(4)) === 0) close(id)
        },
        session.preview
          ? (packet) => {
              const full = session.frameRequest?.[1] === 0 || packet[1] === 0
              session.frameRequest = packet
              if (full) packet[1] = 0
              if (session.frameTimer) return
              session.frameTimer = setTimeout(
                () => {
                  session.frameTimer = undefined
                  const request = session.frameRequest
                  session.frameRequest = undefined
                  if (!request || !sessions.has(id) || !valid(session) || !session.auth?.authenticated) return
                  session.lastFrameAt = Date.now()
                  session.guest?.write(request)
                },
                Math.max(0, 1_000 - (Date.now() - (session.lastFrameAt ?? 0))),
              )
            }
          : undefined,
      )
      // No URL supplied by the caller reaches this connection: only the runtime's loopback forward.
      const guest = createConnection(session.path ? { path: session.path } : { host: "127.0.0.1", port: session.port })
      session.guest = guest
      const auth = new VncAuthenticator(session.password, (bytes) => guest.write(bytes))
      session.password = ""
      session.auth = auth
      guest.setTimeout(12_000, () => close(id, "authentication timeout"))
      guest.on("data", (data) => {
        if (!sessions.has(id)) return
        try {
          const ready = auth.authenticated
          const output = auth.push(data)
          if (!valid(session)) return close(id)
          if (!ready && auth.authenticated) {
            // Incremental VNC updates can be silent indefinitely on a static desktop.
            // This timeout bounds authentication, not display liveness.
            guest.setTimeout(0)
            if (viewer.send(Buffer.from("RFB 003.008\n")) === 0) return close(id)
          }
          if (output.length && viewer.send(output) === 0) close(id)
        } catch (error) {
          kernel.log({ level: "warn", module: "vm-desktop", msg: kernel.redact(String(error)) })
          close(id)
        }
      })
      guest.on("error", () => close(id))
      guest.on("close", () => close(id))
    },
    message: (id, bytes) => {
      const session = sessions.get(id)
      if (!session?.guest || !session.auth?.authenticated || !valid(session) || typeof bytes === "string") {
        close(id)
        return
      }
      try {
        const data = session.gate.push(bytes, session.control)
        if (!sessions.has(id)) return
        if (process.env.TOURI_DESKTOP_TRACE === "1")
          log("Desktop input gate", { control: session.control, received: bytes.length, forwarded: data.length })
        if (data.length && !session.guest.write(data) && session.guest.writableLength > 1_048_576) close(id)
      } catch (error) {
        kernel.log({ level: "warn", module: "vm-desktop", msg: kernel.redact(String(error)) })
        close(id)
      }
    },
    close: (id, closeCode) => close(id, "viewer closed", closeCode),
    closeBot: async (botId) => {
      const waits: Array<Promise<void>> = []
      for (const [controller, request] of pending)
        if (request.botId === botId) {
          controller.abort()
          waits.push(request.settled)
        }
      for (const [id, session] of sessions)
        if (session.botId === botId) {
          waits.push(close(id))
        }
      await Promise.all(waits)
      await drain(botId)
    },
    revokeControl,
    dispose: () => {
      clearInterval(revocationTimer)
      revocation.dispose()
      if (disposed) return
      disposed = true
      epoch += 1
      for (const controller of pending.keys()) controller.abort()
      for (const id of sessions.keys()) close(id)
      unsubscribe()
      unhost()
    },
  }
  const routes: RouteModule = {
    name: "vm-desktop",
    routes: [
      {
        method: "POST",
        path: "/bots/:id/desktop",
        handler: async ({ params, body, signal }) => {
          const botId = params.id ?? ""
          const bot = botFor(botId)
          if (!bot) return { status: 404, json: { error: "Bot não encontrado" } }
          if (bot.machine === "local") return { status: 409, json: { error: "Este bot não usa uma máquina virtual" } }
          const control = (body as { control?: unknown } | null)?.control ?? false
          const resume = (body as { resume?: unknown } | null)?.resume === true
          const preview = (body as { preview?: unknown } | null)?.preview ?? false
          if (typeof preview !== "boolean" || (preview && control))
            return { status: 400, json: { error: "A prévia permite somente observar" } }
          if (preview && !vm.states().some((state) => state.botId === botId && state.status === "running"))
            return { status: 409, json: { error: "A máquina está parada" } }
          log("Desktop control requested", { botId, control, computerUse: bot.computerUse, epoch })
          if (typeof control !== "boolean") return { status: 400, json: { error: "Modo de controle inválido" } }
          if (control && bot.machine === "cloud")
            return {
              status: 409,
              json: {
                error:
                  "O controle manual não está disponível nesta máquina. Você pode acompanhar a tela e conversar com o bot.",
              },
            }
          if (disposed || sessions.size + pending.size >= 16)
            return { status: 503, json: { error: "Conexões da tela indisponíveis" } }
          const targetEpoch = control ? changeTarget(botId) : targetEpochs.get(botId)
          const startEpoch = epoch
          const controller = new AbortController()
          let settle = () => {}
          const settled = new Promise<void>((resolve) => {
            settle = resolve
          })
          if (control)
            for (const [previous, request] of pending) if (request.botId === botId && request.control) previous.abort()
          pending.set(controller, { control, botId, settled })
          const abort = () => controller.abort()
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          const timeout = setTimeout(abort, 600_000)
          let release: (() => Promise<void>) | undefined
          try {
            // A chat observer never boots, acquires or holds a machine awake.
            release = preview
              ? async () => {}
              : await vm.acquire({ botId, signal: controller.signal, ...(resume ? { runningOnly: true } : {}) })
            const { hostPort, password, url } = await vm.desktopConnection({
              botId,
              control,
              signal: controller.signal,
            })
            controller.signal.throwIfAborted()
            const currentBot = botFor(botId)
            if (
              disposed ||
              (currentBot?.machine !== "vm" && currentBot?.machine !== "cloud") ||
              (control && (startEpoch !== epoch || currentBot.machine !== "vm"))
            )
              throw new Error("Controle interrompido; conecte novamente em modo de observação")
            if (control && bot.machine === "vm") {
              const input = kernel.services.use("computer.input")
              if (!input) throw new Error("Controle manual indisponível")
              for (const [id, session] of [...sessions])
                if (session.botId === botId && session.control) await close(id, "human takeover")
              await drain(botId)
              await input.take(botId, controller.signal)
              if (startEpoch !== epoch || targetEpoch !== targetEpochs.get(botId))
                throw new Error("Controle interrompido")
            }
            const id = randomBytes(24).toString("hex")
            log("Desktop control granted", { botId, control, epoch, startEpoch })
            sessions.set(id, {
              ...(deviceSession(signal) ? { device: deviceSession(signal) } : {}),
              preview,
              botId,
              control,
              claimed: false,
              release,
              port: hostPort,
              ...(url.startsWith("unix:") ? { path: url.slice(5) } : {}),
              password,
              timer: setTimeout(() => close(id, "claim timeout"), 15_000),
              expiresAt: Date.now() + 15_000,
              gate: new DesktopInputGate(),
            })
            release = undefined
            return {
              status: 200,
              json: {
                sessionId: id,
                path: `/api/v1/desktop/${id}/socket`,
                control,
                humanControl: kernel.services.use("computer.input")?.human(botId) ?? false,
              },
            }
          } catch (error) {
            return {
              status: 409,
              json: { error: kernel.redact(error instanceof Error ? error.message : "Tela indisponível") },
            }
          } finally {
            clearTimeout(timeout)
            signal.removeEventListener("abort", abort)
            pending.delete(controller)
            try {
              await release?.()
            } finally {
              settle()
            }
          }
        },
      },
      {
        method: "POST",
        path: "/bots/:id/desktop/return",
        handler: async ({ params }) => {
          const botId = params.id ?? ""
          if (botFor(botId)?.machine !== "vm") return { status: 409, json: { error: "Controle manual indisponível" } }
          const stopEpoch = epoch
          const targetEpoch = changeTarget(botId)
          for (const [controller, request] of pending)
            if (request.botId === botId && request.control) controller.abort()
          for (const [id, session] of [...sessions])
            if (session.botId === botId && session.control) await close(id, "explicit handback")
          await drain(botId)
          if (stopEpoch !== epoch || targetEpoch !== targetEpochs.get(botId))
            return { status: 409, json: { error: "O controle mudou. Tente novamente." } }
          kernel.services.use("computer.input")?.handBack(botId)
          return { status: 200, json: {} }
        },
      },
      {
        method: "POST",
        path: "/desktop/:id/text",
        handler: async ({ params, body, signal }) => {
          const session = sessions.get(params.id ?? "")
          if (session?.device && session.device.deviceId !== deviceSession(signal)?.deviceId)
            return { status: 403, json: { error: "A sessão pertence a outro dispositivo" } }
          if (!session?.control || !session.auth?.authenticated || !valid(session))
            return { status: 403, json: { error: "Ative o controle da tela para digitar" } }
          const text = (body as { text?: unknown } | null)?.text
          if (typeof text !== "string" || !text || Buffer.byteLength(text) > 65_536 || text.includes("\0"))
            return { status: 400, json: { error: "Texto inválido ou muito longo" } }
          if (session.inputAbort) return { status: 409, json: { error: "Aguarde a colagem anterior" } }
          const controller = new AbortController()
          session.inputAbort = controller
          let settle = () => {}
          session.inputSettled = new Promise<void>((resolve) => {
            settle = resolve
          })
          const abort = () => controller.abort()
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          try {
            if (paste && kernel.services.use("store.api")?.getBot({ botId: session.botId })?.machine === "vm")
              await paste({ botId: session.botId, text, signal: controller.signal })
            else {
              const result = await vm.exec({
                botId: session.botId,
                command: "python3",
                args: ["-c", clipboard, text],
                signal: controller.signal,
              })
              if (!result.success || result.code !== 0) throw new Error("Falha na colagem")
            }
            return { status: 200, json: {} }
          } catch {
            return { status: 409, json: { error: "Não foi possível colar o texto na VM" } }
          } finally {
            signal.removeEventListener("abort", abort)
            delete session.inputAbort
            delete session.inputSettled
            settle()
          }
        },
      },
      {
        method: "DELETE",
        path: "/desktop/:id",
        handler: async ({ params, signal }) => {
          const session = sessions.get(params.id ?? "")
          if (session?.device && session.device.deviceId !== deviceSession(signal)?.deviceId)
            return { status: 403, json: { error: "A sessão pertence a outro dispositivo" } }
          close(params.id ?? "")
          return { status: 200, json: {} }
        },
      },
    ],
  }
  return { service, routes }
}
