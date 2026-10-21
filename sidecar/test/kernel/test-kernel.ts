import { mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HostNotification, Kernel, RouteHandler } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createAppPaths } from "../../src/kernel/paths"
import { createServices } from "../../src/kernel/services"

/** Runs real stores and engines without starting HTTP or a host socket. */
export const testKernel = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-kernel-fixture-"))
  const db = openDatabase({ filename: join(root, "touri.db") })
  const listeners = new Set<Parameters<Kernel["subscribe"]>[0]>()
  const hostListeners = new Set<(notification: HostNotification) => void>()
  const routes = new Map<string, RouteHandler>()
  let seq = 0
  const spawnTree = mock(() => {
    throw new Error("Unexpected subprocess")
  })
  const kernel: Kernel = {
    db,
    paths: createAppPaths({ appData: root }),
    services: createServices(),
    spawnTree,
    publish: (event) => {
      for (const listener of listeners) listener({ event, seq: ++seq, at: Date.now() })
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onHostNotification: (listener) => {
      hostListeners.add(listener)
      return () => {
        hostListeners.delete(listener)
      }
    },
    registerRoutes: (module) => {
      for (const route of module.routes) routes.set(`${route.method} ${route.path}`, route.handler)
    },
    registerTools: ({ tools }) => ({ success: true, count: tools.length }),
    callHost: async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "No host in fixture" }),
    redact: (text) => text,
    addRedactionValue: () => {},
    shellEnv: async () => ({}),
    newId: () => crypto.randomUUID(),
    log: () => {},
  }
  return {
    kernel,
    db,
    spawnTree,
    host: (notification: HostNotification) => {
      for (const listener of [...hostListeners]) listener(notification)
    },
    request: async (route: string, body: unknown = {}, params: Record<string, string> = {}) => {
      const handler = routes.get(route)
      if (!handler) throw new Error(`Missing route: ${route}`)
      const response = await handler({ body, params, query: {}, signal: new AbortController().signal })
      if (!("json" in response)) throw new Error("Expected JSON response")
      return response
    },
    close: () => {
      kernel.services.use("storage.threadDeletion")?.dispose()
      kernel.services.use("storage.threadTitles")?.dispose()
      kernel.services.use("storage.botDeletion")?.dispose()
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
