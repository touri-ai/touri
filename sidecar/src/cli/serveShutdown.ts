import type { Kernel } from "@touri/contracts"

type Signals = {
  on: (event: "SIGTERM" | "SIGINT", listener: () => void) => unknown
  off: (event: "SIGTERM" | "SIGINT", listener: () => void) => unknown
}
type Schedule = (callback: () => void, delayMs: number) => () => void

/** A second signal interrupts the drain; every shutdown stage shares the original backstop. */
export const registerServeShutdown = ({
  drainTimeoutMs,
  beginDrain,
  shutdown,
  finish,
  log,
  signals = process,
  exit = process.exit,
  schedule = scheduleTimeout,
}: {
  drainTimeoutMs: number
  beginDrain: () => Promise<void> | void
  shutdown: () => Promise<void>
  finish: () => Promise<void>
  log: Kernel["log"]
  signals?: Signals
  exit?: (code: number) => void
  schedule?: Schedule
}): void => {
  // Lifecycle state is local to this server's signal registration.
  let stopping = false
  const forced = Promise.withResolvers<"forced">()
  const stop = (): void => {
    if (stopping) {
      log({ level: "warn", module: "cli", msg: "Segundo sinal recebido; interrompendo o encerramento gradual." })
      forced.resolve("forced")
      return
    }
    stopping = true
    const deadline = Promise.withResolvers<"deadline">()
    const cancelDeadline = schedule(() => deadline.resolve("deadline"), drainTimeoutMs)
    const cancelBackstop = schedule(() => exit(1), drainTimeoutMs + 20_000)
    const drain = Promise.resolve()
      .then(beginDrain)
      .then(
        () => "drained" as const,
        () => {
          log({ level: "error", module: "cli", msg: "O encerramento gradual falhou; interrompendo o runtime." })
          return "failed" as const
        },
      )
    void (async () => {
      const result = await Promise.race([drain, deadline.promise, forced.promise])
      cancelDeadline()
      await shutdown()
      await finish()
      cancelBackstop()
      signals.off("SIGTERM", stop)
      signals.off("SIGINT", stop)
      exit(result === "failed" ? 1 : 0)
    })().catch(() => exit(1))
  }
  signals.on("SIGTERM", stop)
  signals.on("SIGINT", stop)
}

const scheduleTimeout: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}
