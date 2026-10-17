import type { Database } from "bun:sqlite"
import type { DoctorCheck, DoctorReport, Kernel } from "@touri/contracts"
import { storageStats } from "../kernel/data-maintenance"
import { hostPlatform } from "../platform"
import { check } from "./check"
import { createDoctorCommand } from "./command"
import { collectLocalChecks, sidecarChecks } from "./local"
import { mcpStartupChecks, orphanShimCheck } from "./mcp"
import { collectNetworkChecks, withinDeadline } from "./network"

export type DoctorCollector = (signal: AbortSignal) => Promise<Array<DoctorCheck>>

export const createDoctorService = (collect: DoctorCollector, timeoutMs = 20_000) => {
  let report: DoctorReport = { checks: [], checkedAt: null, running: false }
  let current: AbortController | null = null
  let pending: Promise<void> | null = null
  let disposed = false

  const start = (): void => {
    if (pending || disposed) return
    const controller = new AbortController()
    current = controller
    report = { ...report, running: true }
    // Start independently of the startup handshake and HTTP response.
    pending = Promise.resolve()
      .then(() => withinDeadline(collect, controller.signal, timeoutMs))
      .then((checks) => {
        if (!controller.signal.aborted) report = { checks, running: false, checkedAt: Date.now() }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          report = {
            checks: [
              ...report.checks.filter((item) => item.id !== "doctor"),
              check(
                "doctor",
                "Diagnóstico",
                "fail",
                "Não foi possível concluir o diagnóstico. Tente novamente; se persistir, reabra o touri.",
                hostPlatform.appOpenCommand,
              ),
            ],
            running: false,
            checkedAt: Date.now(),
          }
      })
      .finally(() => {
        pending = null
        current = null
      })
  }

  return {
    start,
    snapshot: (refresh = false): DoctorReport => {
      if (refresh || report.checkedAt === null) start()
      return { ...report, checks: report.checks.map((item) => ({ ...item })) }
    },
    settled: (): Promise<void> => pending ?? Promise.resolve(),
    dispose: (): void => {
      disposed = true
      current?.abort()
      report = { ...report, running: false }
    },
  }
}

export const collectDoctorChecks = async (kernel: Kernel, signal: AbortSignal): Promise<Array<DoctorCheck>> => {
  // Read the schema before asynchronous work; shutdown can close the database.
  const checks = sidecarChecks(kernel)
  // The shim scan runs `ps` asynchronously (#121); keep its place before the version row.
  const orphans = await orphanShimCheck(kernel.paths.runDir)
  const versionRow = checks.findIndex((item) => item.id === "sidecar-version")
  checks.splice(versionRow < 0 ? checks.length : versionRow, 0, orphans)
  const local = async (): Promise<Array<DoctorCheck>> => {
    const environment = await withinDeadline(() => kernel.shellEnv(), signal, 9000)
    return collectLocalChecks(kernel, environment, createDoctorCommand(kernel, environment), signal)
  }
  const results = await Promise.allSettled([local(), collectNetworkChecks(signal)])
  signal.throwIfAborted()
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") checks.push(...result.value)
    else
      checks.push(
        check(
          index === 0 ? "local-checks" : "network-checks",
          index === 0 ? "Ambiente local" : "Conexão com os provedores",
          "fail",
          "Esta parte do diagnóstico não pôde ser concluída. Execute novamente para verificar o ambiente.",
          hostPlatform.appOpenCommand,
        ),
      )
  }
  return checks
}

export const installDoctor = (
  kernel: Kernel,
  collect: DoctorCollector = (signal) => collectDoctorChecks(kernel, signal),
) => {
  const service = createDoctorService(collect)
  kernel.services.provide("doctor", service)
  kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") service.dispose()
  })
  kernel.registerRoutes({
    name: "doctor",
    routes: [
      {
        method: "GET",
        path: "/doctor",
        handler: async ({ query }) => {
          const report = service.snapshot(query.refresh === "true")
          return {
            status: 200,
            json: {
              ...report,
              checks: [
                ...report.checks.filter((item) => !item.id.startsWith("vm-mcp:")),
                ...mcpStartupChecks(kernel.db as Database),
              ],
            },
          }
        },
      },
      {
        method: "GET",
        path: "/doctor/storage",
        handler: async () => ({
          status: 200,
          json: {
            storage: storageStats(kernel.db as Database, kernel.paths.db),
            maintenance: kernel.services.use("storage.maintenance")?.snapshot(),
          },
        }),
      },
      {
        method: "POST",
        path: "/doctor/storage/compact",
        handler: async ({ body }) => {
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).some((key) => key !== "vacuum") ||
            ("vacuum" in body && typeof body.vacuum !== "boolean")
          )
            return { status: 400, json: { errorCode: "INVALID_ARGS" } }
          const maintenance = kernel.services.use("storage.maintenance")
          if (!maintenance?.start("vacuum" in body && body.vacuum === true))
            return {
              status: 409,
              json: { errorCode: "CONFLICT", error: "Aguarde a migração ou compactação em andamento." },
            }
          return { status: 202, json: { maintenance: maintenance.snapshot() } }
        },
      },
    ],
  })
  return service
}
