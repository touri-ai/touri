import type { Database } from "bun:sqlite"

type Shutdown = () => void | Promise<void>
type Lifecycle = { tasks: Set<Shutdown>; stopping?: Promise<void> }

// Each connection owns its producers, including optional modules without a kernel service.
const lifecycles = new WeakMap<Database, Lifecycle>()

export const onDatabaseShutdown = (database: Database, stop: Shutdown): void => {
  const lifecycle = ensureLifecycle(database)
  if (lifecycle.stopping) throw new Error("DATABASE_CLOSING")
  lifecycle.tasks.add(stop)
}

export const stopDatabaseTasks = (database: Database): Promise<void> => {
  const lifecycle = ensureLifecycle(database)
  lifecycle.stopping ??= Promise.resolve().then(async () => {
    const results = await Promise.allSettled(Array.from(lifecycle.tasks, (stop) => Promise.resolve().then(stop)))
    lifecycle.tasks.clear()
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw new Error("DATABASE_SHUTDOWN_FAILED")
  })
  void lifecycle.stopping.catch(() => undefined)
  return lifecycle.stopping
}

const ensureLifecycle = (database: Database): Lifecycle => {
  const existing = lifecycles.get(database)
  if (existing) return existing
  const lifecycle = { tasks: new Set<Shutdown>() }
  lifecycles.set(database, lifecycle)
  return lifecycle
}
