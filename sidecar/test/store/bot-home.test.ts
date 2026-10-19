import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { RouteModule } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { removePrivateTree } from "../../src/kernel/files"
import { init as initStore } from "../../src/store"
import { createBotHomeWriter, getBotHomeCommand, stopBotHomeWriter, writeBotHome } from "../../src/store/bot-home"

// Test resources are recorded locally so afterEach can release every helper before removing files.
const cleanups = new Set<() => Promise<void>>()
const roots: string[] = []
afterEach(async () => {
  for (const cleanup of Array.from(cleanups).reverse()) await cleanup()
  cleanups.clear()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

for (const entry of ["../../src/store/bot-home.ts", "../../src/main.ts", "../../src/cli/main.ts"]) {
  test(`the ${entry.includes("cli/") ? "server CLI" : "desktop sidecar"} entry can write the bounded private bot home`, async () => {
    const root = await mkdtemp(join(tmpdir(), "touri-home-entry-"))
    roots.push(root)
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL(entry, import.meta.url)), "write-bot-home"], {
      env: { ...process.env, TOURI_APP_DATA: root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    child.stdin.write(
      `${JSON.stringify({ operation: "write", botId: "fixture-bot", instructions: "Useful synthetic instructions." })}\n`,
    )
    await child.stdin.end()

    const output = await new Response(child.stdout).text()
    const code = await child.exited
    clearTimeout(timer)

    expect(code).toBe(0)
    expect(output).toBe("R1")
    expect(await readFile(join(root, "bots", "fixture-bot", "SOUL.md"), "utf8")).toBe("Useful synthetic instructions.")
  })
}

test("private bot home cleanup unlinks symlinks without deleting their targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-home-cleanup-"))
  roots.push(root)
  const home = join(root, "bots", "fixture-bot")
  const outside = join(root, "outside.txt")
  await mkdir(home, { recursive: true })
  await writeFile(join(home, "SOUL.md"), "Synthetic instructions.")
  await writeFile(outside, "Keep this file.")
  await symlink(outside, join(home, "external-link"))

  removePrivateTree({ root, path: home })

  expect(await readFile(outside, "utf8")).toBe("Keep this file.")
  await expect(readdir(home)).rejects.toThrow()
})

for (const command of [
  { operation: "write", botId: "../escape", instructions: "Fixture" },
  { operation: "write", botId: "fixture", instructions: "Fixture", unexpected: true },
  { operation: "remove", botId: "fixture", unexpected: true },
  { operation: "unknown", botId: "fixture" },
  { operation: "write", botId: "fixture", instructions: "x".repeat(128 * 1024) },
]) {
  test(`rejects invalid writer input: ${command.operation}, ${command.botId}, ${Object.hasOwn(command, "unexpected")}`, () => {
    expect(() => getBotHomeCommand(JSON.stringify(command))).toThrow()
  })
}

test("concurrent commands reuse one helper, stay FIFO and reject overflow", async () => {
  const completed = Promise.withResolvers<void>()
  // Recording the helper boundary verifies admission without mutating production globals.
  const calls: string[] = []
  const starts: string[] = []
  const writer = createBotHomeWriter({
    root: "/tmp/fixture",
    maxPending: 3,
    createHelper: () => {
      starts.push("start")
      return {
        execute: async (command) => {
          calls.push(command)
          await completed.promise
        },
        stop: async () => {
          completed.resolve()
        },
      }
    },
  })
  cleanups.add(writer.close)
  const commands = ["one", "two", "three"].map((botId) => ({ operation: "remove" as const, botId }))
  const operations = commands.map((command) => writer.run(command))

  await expect(writer.run({ operation: "remove", botId: "overflow" })).rejects.toThrow("busy")
  expect(calls).toHaveLength(1)
  completed.resolve()
  await Promise.all(operations)

  expect(starts).toHaveLength(1)
  expect(calls.map((command) => JSON.parse(command).botId)).toEqual(["one", "two", "three"])
})

test("a deadline kills a stuck helper process and releases its FIFO slot", async () => {
  const children: ReturnType<typeof Bun.spawn>[] = []
  const writer = createBotHomeWriter({
    root: "/tmp/fixture",
    timeoutMs: 40,
    createHelper: () => {
      const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      children.push(child)
      return {
        execute: async () => {
          await child.exited
          throw new Error("Stopped")
        },
        stop: async () => {
          child.kill("SIGKILL")
          await child.exited
        },
      }
    },
  })
  cleanups.add(writer.close)

  await expect(writer.run({ operation: "remove", botId: "fixture" })).rejects.toThrow("timed out")
  await writer.close()

  expect(children).toHaveLength(1)
  expect(children[0]?.signalCode).toBe("SIGKILL")
})

test("cancelling an active operation terminates the helper and a queued cancellation is skipped", async () => {
  const blocked = Promise.withResolvers<void>()
  const stopped: string[] = []
  const calls: string[] = []
  const writer = createBotHomeWriter({
    root: "/tmp/fixture",
    createHelper: () => ({
      execute: async (command) => {
        calls.push(command)
        await blocked.promise
      },
      stop: async () => {
        stopped.push("stop")
        blocked.resolve()
      },
    }),
  })
  cleanups.add(writer.close)
  const active = new AbortController()
  const queued = new AbortController()
  const first = writer.run({ operation: "remove", botId: "active" }, active.signal)
  const second = writer.run({ operation: "remove", botId: "queued" }, queued.signal)
  const results = Promise.allSettled([first, second])
  await new Promise<void>((resolve) => setImmediate(resolve))

  queued.abort()
  active.abort()
  await results
  await writer.close()

  expect(stopped.length).toBeGreaterThan(0)
  expect(calls).toHaveLength(1)
})

test("a failed write preserves its error when cleanup fails", async () => {
  const root = await makeRoot()
  const runtime = createKernel({ appData: root })
  cleanups.add(runtime.stop)
  const logs: string[] = []
  const kernel = {
    ...runtime.kernel,
    log: (entry: { msg: string }) => {
      logs.push(entry.msg)
    },
  }
  cleanups.add(() => stopBotHomeWriter(kernel))
  await mkdir(join(root, "outside"))
  await rm(join(root, "bots"), { recursive: true })
  await symlink(join(root, "outside"), join(root, "bots"))

  await expect(writeBotHome(kernel, "fixture", "Fixture", new AbortController().signal)).rejects.toThrow(
    "Bot home operation failed",
  )

  expect(logs).toEqual(["Could not remove uncommitted bot home"])
  expect(await readdir(join(root, "outside"))).toEqual([])
})

test("cancellation immediately after the write removes the uncommitted home", async () => {
  const controller = new AbortController()
  const f = await makeStore(async (...args) => {
    const home = await writeBotHome(...args)
    controller.abort()
    return home
  })

  const response = await f.create(controller.signal)

  expect(response.status).toBe(500)
  expect(await readdir(join(f.root, "bots"))).toEqual([])
  expect(f.database.query("SELECT count(*) AS count FROM bots").get()).toEqual({ count: 0 })
})

test("a failed database insert removes the written home and preserves the database error", async () => {
  const f = await makeStore()
  f.database.exec(
    "CREATE TRIGGER reject_fixture BEFORE INSERT ON bots BEGIN SELECT RAISE(FAIL, 'fixture insert rejected'); END",
  )

  await expect(f.create()).rejects.toThrow("fixture insert rejected")

  expect(await readdir(join(f.root, "bots"))).toEqual([])
})

test("the creation limit does not change existing large instruction edits", async () => {
  const f = await makeStore()
  const created = await f.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  const instructions = "x".repeat(121 * 1024)

  const updated = await f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions },
    signal: new AbortController().signal,
  })

  expect(updated.status).toBe(200)
  expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(instructions)
})

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-home-store-"))
  roots.push(root)
  return root
}

const makeStore = async (writeHome?: typeof writeBotHome) => {
  const root = await makeRoot()
  const runtime = createKernel({ appData: root })
  cleanups.add(runtime.stop)
  // Route capture exercises the real handler without relying on network disconnect timing.
  const modules: RouteModule[] = []
  const kernel = {
    ...runtime.kernel,
    registerRoutes: (module: RouteModule) => {
      modules.push(module)
    },
  }
  await initStore(kernel, undefined, undefined, writeHome)
  cleanups.add(() => stopBotHomeWriter(kernel))
  const module = modules.find((module) => module.name === "store")
  const getRoute = (method: string, path: string) => {
    const route = module?.routes.find((route) => route.method === method && route.path === path)
    if (!route) throw new Error("Missing store route")
    return route
  }
  const create = (signal = new AbortController().signal) =>
    getRoute("POST", "/bots").handler({ params: {}, query: {}, body: { name: "Fixture", provider: "claude" }, signal })
  return { root, database: kernel.db as Database, create, routes: getRoute("PATCH", "/bots/:id") }
}
