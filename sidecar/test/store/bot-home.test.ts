import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Kernel, RouteModule } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { atomicWriteFile, removePrivateTree } from "../../src/kernel/files"
import { createPerformanceStageTracker } from "../../src/kernel/performance"
import { init as initStore } from "../../src/store"
import {
  type BotHomeCommand,
  createBotHomeWriter,
  getBotHomeCommand,
  startBotHomeHelper,
  stopBotHomeWriter,
  updateBotHome,
  writeBotHome,
} from "../../src/store/bot-home"
import { getMaximum, getPercentile, startEventLoopLagProbe } from "../fakes/latency"

// Test resources are recorded locally so afterEach can release every helper before removing files.
const cleanups = new Set<() => void | Promise<void>>()
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
    const frame = Buffer.from(
      JSON.stringify({ operation: "write", botId: "fixture-bot", instructions: "Useful synthetic instructions." }),
    )
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(frame.length)
    child.stdin.write(prefix)
    child.stdin.write(frame)
    await child.stdin.end()

    const output = await new Response(child.stdout).text()
    const code = await child.exited
    clearTimeout(timer)

    expect(code).toBe(0)
    expect(output).toBe("R1")
    expect(await readFile(join(root, "bots", "fixture-bot", "SOUL.md"), "utf8")).toBe("Useful synthetic instructions.")
  })
}

for (const [label, input] of [
  ["oversized frame", Buffer.from([0, 2, 0, 1])],
  ["truncated frame length", Buffer.from([0, 0])],
  ["truncated frame content", Buffer.from([0, 0, 0, 3, 123])],
] as const) {
  test(`the helper refuses an ${label} before writing files`, async () => {
    const root = await makeRoot()
    const child = Bun.spawn(
      [process.execPath, fileURLToPath(new URL("../../src/store/bot-home.ts", import.meta.url)), "write-bot-home"],
      {
        env: { ...process.env, TOURI_APP_DATA: root },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        signal: AbortSignal.timeout(10_000),
      },
    )

    child.stdin.write(input)
    await child.stdin.end()
    const output = await new Response(child.stdout).text()
    const code = await child.exited

    expect(code).toBe(1)
    expect(output).toBe("R")
    expect(await readdir(root)).toEqual([])
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
  { operation: "edit", botId: "fixture", instructions: "x".repeat(2 * 1024 * 1024) },
]) {
  test(`rejects invalid writer input: ${command.operation}, ${command.botId}, ${Object.hasOwn(command, "unexpected")}`, () => {
    expect(() => getBotHomeCommand(JSON.stringify(command))).toThrow()
  })
}

test("concurrent commands reuse one helper, stay FIFO and reject overflow", async () => {
  const completed = Promise.withResolvers<void>()
  // Recording the helper boundary verifies admission without mutating production globals.
  const calls: BotHomeCommand[] = []
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
  expect(calls.map((command) => command.botId)).toEqual(["one", "two", "three"])
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
  const calls: BotHomeCommand[] = []
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

test("cancelling a large edit waiting for budget rejects before the preceding operation finishes", async () => {
  const blocked = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const calls: BotHomeCommand[] = []
  const prepared: string[] = []
  const writer = createBotHomeWriter({
    root: "/fixture",
    createHelper: () => ({
      execute: async (text) => {
        calls.push(text)
        started.resolve()
        await blocked.promise
      },
      stop: async () => blocked.resolve(),
    }),
  })
  cleanups.add(writer.close)
  const first = writer.run({ operation: "remove", botId: "blocked" })
  const controller = new AbortController()
  const edit = writer.run(
    { operation: "edit", botId: "fixture", instructions: "x".repeat(3 * 1024 * 1024) },
    controller.signal,
    {
      prepare: () => {
        prepared.push("prepared")
        return { commit: () => {} }
      },
    },
  )
  const results = Promise.allSettled([first, edit])
  await started.promise

  controller.abort(new Error("edit cancelled"))
  const rejectedPromptly = await Promise.race([
    edit.then(
      () => false,
      (error) => error.message === "edit cancelled",
    ),
    Bun.sleep(100).then(() => false),
  ])

  expect(rejectedPromptly).toBe(true)
  expect(calls).toHaveLength(1)
  expect(prepared).toEqual([])
  const following = writer.run({ operation: "remove", botId: "following" })
  blocked.resolve()
  await Promise.all([results, following])
  expect(calls.map((command) => command.botId)).toEqual(["blocked", "following"])
})

test("large edits wait in FIFO order until their retained content budget is free", async () => {
  const started = Promise.withResolvers<void>()
  const blocked = Promise.withResolvers<void>()
  const calls: BotHomeCommand[] = []
  let released = false
  const writer = createBotHomeWriter({
    root: "/fixture",
    createHelper: () => ({
      execute: async (command) => {
        calls.push(command)
        if (!released) {
          started.resolve()
          await blocked.promise
        }
      },
      stop: async () => blocked.resolve(),
    }),
  })
  cleanups.add(writer.close)
  const instructions = "x".repeat(3 * 1024 * 1024)
  const edit = writer.run({ operation: "edit", botId: "fixture", instructions })
  await started.promise
  const secondEdit = writer.run({ operation: "edit", botId: "second", instructions })
  await Bun.sleep(10)

  expect(calls).toEqual([{ operation: "snapshot", botId: "fixture" }])
  released = true
  blocked.resolve()
  await Promise.all([edit, secondEdit])

  expect(calls.map((command) => command.botId)).toEqual(["fixture", "fixture", "fixture", "second", "second", "second"])
})

test("admitted and waiting edits share a 64 MiB retained-text cap and release it after completion", async () => {
  const blocked = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const writer = createBotHomeWriter({
    root: "/fixture",
    createHelper: () => ({
      execute: async () => {
        started.resolve()
        await blocked.promise
      },
      stop: async () => blocked.resolve(),
    }),
  })
  cleanups.add(writer.close)
  const writeEditedHome: typeof updateBotHome = (kernel, botId, instructions, signal, prepare) =>
    updateBotHome(kernel, botId, instructions, signal, prepare, writer)
  const fixture = await makeStore(undefined, writeEditedHome)
  const created = await fixture.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  const instructions = "x".repeat(16 * 1024 * 1024)
  const first = writer.run({ operation: "edit", botId: "first", instructions })
  await started.promise
  const second = writer.run({ operation: "edit", botId: "second", instructions })

  const overflow = writer.run({ operation: "edit", botId: "overflow", instructions: "x".repeat(3 * 1024 * 1024) })
  const result = await Promise.race([
    overflow.then(
      () => "accepted",
      (error: Error) => error.message,
    ),
    Bun.sleep(100).then(() => "still waiting"),
  ])
  const response = await Promise.race([
    fixture.routes.handler({
      params: { id: bot.id },
      query: {},
      body: { instructions: "x".repeat(3 * 1024 * 1024) },
      signal: new AbortController().signal,
    }),
    Bun.sleep(100).then(() => ({ status: 0 })),
  ])

  expect(result).toBe("Bot home writer is busy")
  expect(response.status).toBe(409)
  blocked.resolve()
  await Promise.all([first, second])
  const normalInstructions = "x".repeat(3 * 1024 * 1024)
  await Promise.all([
    writer.run({ operation: "edit", botId: "third", instructions: normalInstructions }),
    writer.run({ operation: "edit", botId: "fourth", instructions: normalInstructions }),
  ])
})

test("cancelling a waiting edit releases its retained bytes before the active edit finishes", async () => {
  const blocked = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const writer = createBotHomeWriter({
    root: "/fixture",
    createHelper: () => ({
      execute: async () => {
        started.resolve()
        await blocked.promise
      },
      stop: async () => blocked.resolve(),
    }),
  })
  cleanups.add(writer.close)
  const instructions = "x".repeat(16 * 1024 * 1024)
  const first = writer.run({ operation: "edit", botId: "first", instructions })
  await started.promise
  const controller = new AbortController()
  const second = writer.run({ operation: "edit", botId: "second", instructions }, controller.signal)
  const cancelled = second.then(
    () => null,
    (error: Error) => error.message,
  )

  controller.abort(new Error("synthetic cancellation"))
  const reason = await cancelled
  const replacement = writer.run({ operation: "edit", botId: "replacement", instructions })
  blocked.resolve()

  expect(reason).toBe("synthetic cancellation")
  await Promise.all([first, replacement])
})

for (const failure of ["write failure", "cancellation", "snapshot cancellation", "commit failure"] as const) {
  test(`an edit restores the actual large file and removes its backup after ${failure}`, async () => {
    const root = await makeRoot()
    const home = join(root, "bots", "fixture")
    const original = "\u0001".repeat(1024 * 1024)
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "SOUL.md"), original)
    const controller = new AbortController()
    const writer = createBotHomeWriter({
      root,
      createHelper: () => {
        const helper = startBotHomeHelper(root)
        return {
          execute: async (command) => {
            await helper.execute(command)
            if (failure === "snapshot cancellation" && command.operation === "snapshot")
              controller.abort(new Error("synthetic snapshot cancellation"))
            if (command.operation !== "edit") return
            if (failure === "write failure") throw new Error("synthetic write failure")
            if (failure === "cancellation") controller.abort(new Error("synthetic cancellation"))
          },
          stop: helper.stop,
        }
      },
    })
    cleanups.add(writer.close)

    await expect(
      writer.run({ operation: "edit", botId: "fixture", instructions: "Replacement" }, controller.signal, {
        commit: () => {
          if (failure === "commit failure") throw new Error("synthetic commit failure")
        },
      }),
    ).rejects.toThrow(`synthetic ${failure}`)

    expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe(original)
    expect(await readdir(home)).toEqual(["SOUL.md"])
  })
}

for (const target of ["SOUL.md", ".SOUL.edit-backup"] as const) {
  test(`edits refuse a symlink at ${target} without touching its target`, async () => {
    const root = await makeRoot()
    const home = join(root, "bots", "fixture")
    const outside = join(root, "outside.txt")
    await mkdir(home, { recursive: true })
    await writeFile(outside, "Keep this file")
    if (target !== "SOUL.md") await writeFile(join(home, "SOUL.md"), "Previous")
    await symlink(outside, join(home, target))
    const writer = createBotHomeWriter({ root })
    cleanups.add(writer.close)

    await expect(writer.run({ operation: "edit", botId: "fixture", instructions: "Replacement" })).rejects.toThrow(
      "Bot home operation failed",
    )

    expect(await readFile(outside, "utf8")).toBe("Keep this file")
    if (target !== "SOUL.md") expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe("Previous")
  })
}

test("reconciliation replaces a leftover backup with the stored instructions when SOUL.md is missing", async () => {
  const root = await makeRoot()
  const home = join(root, "bots", "fixture")
  await mkdir(home, { recursive: true })
  await writeFile(join(home, ".SOUL.edit-backup"), "Previous instructions")
  const writer = createBotHomeWriter({ root })
  cleanups.add(writer.close)

  await writer.run({ operation: "reconcile", botId: "fixture", instructions: "Stored instructions" })

  expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe("Stored instructions")
  expect(await readdir(home)).toEqual(["SOUL.md"])
})

test("reconciliation uses the stored instructions even when SOUL.md already exists", async () => {
  const root = await makeRoot()
  const home = join(root, "bots", "fixture")
  await mkdir(home, { recursive: true })
  await writeFile(join(home, "SOUL.md"), "Current instructions")
  await writeFile(join(home, ".SOUL.edit-backup"), "Previous instructions")
  const writer = createBotHomeWriter({ root })
  cleanups.add(writer.close)

  await writer.run({ operation: "reconcile", botId: "fixture", instructions: "Stored instructions" })

  expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe("Stored instructions")
  expect(await readdir(home)).toEqual(["SOUL.md"])
})

for (const hasSoul of [false, true]) {
  test(`store startup reconciles a leftover backup from the database with SOUL.md ${hasSoul ? "present" : "missing"}`, async () => {
    const instructions = "Stored instructions.\n".repeat(16 * 1024)
    const { runtime, database, home, botId, root } = await makeStartupStore(instructions)
    const orphan = join(root, "bots", "orphan")
    await mkdir(orphan, { recursive: true })
    await writeFile(join(home, ".SOUL.edit-backup"), "Before the interrupted edit")
    await writeFile(join(orphan, ".SOUL.edit-backup"), "Keep the orphan backup")
    if (hasSoul) await writeFile(join(home, "SOUL.md"), "Uncommitted instructions")
    if (hasSoul) database.query("UPDATE bots SET archived_at = 1 WHERE id = ?").run(botId)

    await initStore(runtime.kernel)

    expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe(instructions)
    expect(await readdir(home)).toEqual(["SOUL.md"])
    expect(await readdir(orphan)).toEqual([".SOUL.edit-backup"])
    expect(await readFile(join(orphan, ".SOUL.edit-backup"), "utf8")).toBe("Keep the orphan backup")
    expect(database.query("SELECT instructions FROM bots WHERE id = ?").get(botId)).toEqual({ instructions })
  })
}

test("startup leaves instructions on disk untouched when there is no edit backup", async () => {
  const { runtime, home } = await makeStartupStore("Stored instructions")
  await writeFile(join(home, "SOUL.md"), "Instructions edited outside the app")

  await initStore(runtime.kernel)

  expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe("Instructions edited outside the app")
  expect(await readdir(home)).toEqual(["SOUL.md"])
})

for (const target of ["SOUL.md", ".SOUL.edit-backup"] as const) {
  test(`startup refuses a symlink at ${target} and still recovers the next bot`, async () => {
    const { runtime, database, home, botId, root } = await makeStartupStore("Stored instructions")
    const nextBotId = "zz-startup-recovery"
    const nextHome = join(root, "bots", nextBotId)
    const nextInstructions = "Stored instructions for the next bot"
    database
      .query(
        "INSERT INTO bots (id, name, provider, instructions, home_dir, created_at, updated_at) SELECT ?, 'Second fixture', provider, ?, ?, 1, 1 FROM bots WHERE id = ?",
      )
      .run(nextBotId, nextInstructions, nextHome, botId)
    await mkdir(nextHome, { recursive: true })
    await writeFile(join(nextHome, ".SOUL.edit-backup"), "Before the next bot's interrupted edit")
    const outside = join(root, "outside.txt")
    await writeFile(outside, "Keep this file")
    if (target === "SOUL.md") await writeFile(join(home, ".SOUL.edit-backup"), "Previous instructions")
    await symlink(outside, join(home, target))
    const { kernel, getLogs } = getRecordingKernel(runtime.kernel)
    cleanups.add(() => stopBotHomeWriter(kernel))
    const stages = createPerformanceStageTracker()

    await initStore(kernel, stages.run)

    expect(kernel.services.use("store.api")).toBeDefined()
    expect(await readFile(outside, "utf8")).toBe("Keep this file")
    expect(await readFile(join(nextHome, "SOUL.md"), "utf8")).toBe(nextInstructions)
    expect(await readdir(nextHome)).toEqual(["SOUL.md"])
    expect(getLogs()).toEqual([
      {
        level: "warn",
        module: "store",
        msg: "Could not reconcile bot home at startup",
        data: { botId, errorClass: "Error" },
      },
    ])
    expect(stages.snapshot()).toContainEqual(
      expect.objectContaining({ stage: "store_bot_home_startup_recovery", calls: 1, asyncCalls: 1 }),
    )
  })
}

test("startup still registers the store when recovery and its diagnostic both fail", async () => {
  const { runtime, home, root } = await makeStartupStore("Stored instructions")
  const outside = join(root, "outside.txt")
  await writeFile(outside, "Keep this file")
  await symlink(outside, join(home, ".SOUL.edit-backup"))
  const { kernel, getLogs } = getRecordingKernel(runtime.kernel, true)
  cleanups.add(() => stopBotHomeWriter(kernel))

  await initStore(kernel)

  expect(kernel.services.use("store.api")).toBeDefined()
  expect(getLogs()).toHaveLength(1)
  expect(await readFile(outside, "utf8")).toBe("Keep this file")
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
  await mkdir(join(root, "outside", "fixture"), { recursive: true })
  await rm(join(root, "bots"), { recursive: true })
  await symlink(join(root, "outside"), join(root, "bots"))

  await expect(writeBotHome(kernel, "fixture", "Fixture", new AbortController().signal)).rejects.toThrow(
    "Bot home operation failed",
  )

  expect(logs).toEqual(["Could not remove uncommitted bot home"])
  expect(await readdir(join(root, "outside"))).toEqual(["fixture"])
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

test("a cleanup failure cannot replace the original database insert error", async () => {
  const f = await makeStore(async (...args) => {
    const home = await writeBotHome(...args)
    const root = args[0].paths.appData
    await rename(join(root, "bots"), join(root, "saved-bots"))
    await mkdir(join(root, "outside", args[1]), { recursive: true })
    await symlink(join(root, "outside"), join(root, "bots"))
    return home
  })
  f.database.exec(
    "CREATE TRIGGER reject_fixture BEFORE INSERT ON bots BEGIN SELECT RAISE(FAIL, 'original database failure'); END",
  )

  await expect(f.create()).rejects.toThrow("original database failure")

  expect(f.database.query("SELECT count(*) AS count FROM bots").get()).toEqual({ count: 0 })
})

for (const [label, instructions] of [
  ["121 KiB", "x".repeat(121 * 1024)],
  ["200 KiB", "x".repeat(200 * 1024)],
  ["80 KiB of escaped newlines", "\n".repeat(80 * 1024)],
  ["3 MiB", "x".repeat(3 * 1024 * 1024)],
  ["1100 KiB of newlines", "\n".repeat(1100 * 1024)],
  ["400 KiB of control characters", "\u0001".repeat(400 * 1024)],
  ["surrogate pairs across frame boundaries", `${"x".repeat(16383)}🧭${"ação\u0000".repeat(12000)}`],
  ["near the HTTP body cap", "x".repeat(32 * 1024 * 1024 - 1024)],
] as const) {
  test(`the creation limit does not change instruction edits with ${label}`, async () => {
    const f = await makeStore()
    const created = await f.create()
    if (!("json" in created)) throw new Error("Expected bot response")
    const { bot } = created.json as { bot: { id: string } }

    const updated = await f.routes.handler({
      params: { id: bot.id },
      query: {},
      body: { instructions },
      signal: new AbortController().signal,
    })

    expect(updated.status).toBe(200)
    expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(instructions)
    expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({ instructions })
  })
}

for (const [label, original] of [
  ["3 MiB", "x".repeat(3 * 1024 * 1024)],
  ["escape-heavy instructions above the old frame and byte budget", "\u0001".repeat(1024 * 1024)],
] as const) {
  test(`an edit can shrink stored ${label}`, async () => {
    const f = await makeStore()
    const created = await f.create()
    if (!("json" in created)) throw new Error("Expected bot response")
    const { bot } = created.json as { bot: { id: string } }
    const home = join(f.root, "bots", bot.id)
    f.database.query("UPDATE bots SET instructions = ? WHERE id = ?").run(original, bot.id)
    await writeFile(join(home, "SOUL.md"), original)

    const updated = await f.routes.handler({
      params: { id: bot.id },
      query: {},
      body: { instructions: "Shorter instructions" },
      signal: new AbortController().signal,
    })

    expect(updated.status).toBe(200)
    expect(await readFile(join(home, "SOUL.md"), "utf8")).toBe("Shorter instructions")
    expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({
      instructions: "Shorter instructions",
    })
    expect(await readdir(home)).toEqual(["SOUL.md"])
  })
}

test("concurrent large instruction edits and bot creation wait for the shared write budget", async () => {
  const f = await makeStore()
  const created = await f.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  const firstInstructions = "a".repeat(3 * 1024 * 1024)
  const secondInstructions = "b".repeat(3 * 1024 * 1024)

  const firstEdit = f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions: firstInstructions },
    signal: new AbortController().signal,
  })
  const secondEdit = f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions: secondInstructions },
    signal: new AbortController().signal,
  })
  const newBot = f.create()
  const [firstResponse, secondResponse, createResponse] = await Promise.all([firstEdit, secondEdit, newBot])

  expect(firstResponse.status).toBe(200)
  expect(secondResponse.status).toBe(200)
  expect(createResponse.status).toBe(201)
  expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({
    instructions: secondInstructions,
  })
  expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(secondInstructions)
})

test("PATCH awaits a slow asynchronous filesystem shim without blocking the event loop", async () => {
  const started = Promise.withResolvers<void>()
  const writeEditedHome = getSlowInstructionEditor(200, () => started.resolve())
  const f = await makeStore(undefined, writeEditedHome)
  const created = await f.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }

  const probe = startEventLoopLagProbe(1)
  cleanups.add(probe.stop)
  const edit = f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions: "Updated without blocking" },
    signal: new AbortController().signal,
  })
  const writerStarted = await Promise.race([started.promise.then(() => true), Bun.sleep(100).then(() => false)])
  expect(writerStarted).toBe(true)

  const response = await edit
  probe.stop()
  const timerLags = probe.getSamples()

  expect(timerLags.length).toBeGreaterThan(10)
  expect(getPercentile(timerLags, 0.95)).toBeLessThan(20)
  expect(getMaximum(timerLags)).toBeLessThan(150)
  expect(response.status).toBe(200)
  expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({
    instructions: "Updated without blocking",
  })
  expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe("Updated without blocking")
})

test("a failed async instruction edit leaves the file and database unchanged", async () => {
  const writeEditedHome: typeof updateBotHome = async () => {
    throw new Error("synthetic disk failure")
  }
  const f = await makeStore(undefined, writeEditedHome)
  const created = await f.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  const original = await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")

  const response = await f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions: "Replacement instructions" },
    signal: new AbortController().signal,
  })

  expect(response.status).toBe(409)
  expect(JSON.stringify(response)).not.toContain("synthetic")

  expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(original)
  expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({
    instructions: original,
  })
})

test("a failed database commit restores the bot home and keeps the original database value", async () => {
  const f = await makeStore()
  const created = await f.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  const original = await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")
  f.database.exec(
    "CREATE TRIGGER reject_instruction_edit BEFORE UPDATE OF instructions ON bots BEGIN SELECT RAISE(FAIL, 'synthetic database failure'); END",
  )

  const response = await f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions: "Replacement instructions" },
    signal: new AbortController().signal,
  })

  expect(response.status).toBe(409)
  expect(JSON.stringify(response)).not.toContain("synthetic")

  expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(original)
  expect(f.database.query("SELECT instructions FROM bots WHERE id = ?").get(bot.id)).toEqual({
    instructions: original,
  })
})

test("a late commit failure restores large instructions and every changed bot field", async () => {
  const f = await makeStore()
  const created = await f.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  const original = "\u0001".repeat(1024 * 1024)
  f.database.query("UPDATE bots SET instructions = ? WHERE id = ?").run(original, bot.id)
  await writeFile(join(f.root, "bots", bot.id, "SOUL.md"), original)
  f.database.exec(
    "CREATE TRIGGER reject_instruction_edit BEFORE UPDATE OF folders_json ON bots BEGIN SELECT RAISE(FAIL, 'synthetic late commit failure'); END",
  )

  const response = await f.routes.handler({
    params: { id: bot.id },
    query: {},
    body: { instructions: "Replacement instructions", name: "Changed name", paused: true },
    signal: new AbortController().signal,
  })

  expect(response.status).toBe(409)
  expect(JSON.stringify(response)).not.toContain("synthetic")

  expect(await readFile(join(f.root, "bots", bot.id, "SOUL.md"), "utf8")).toBe(original)
  expect(f.database.query("SELECT instructions, name, paused FROM bots WHERE id = ?").get(bot.id)).toEqual({
    instructions: original,
    name: "Fixture",
    paused: 0,
  })
})

for (const size of [200 * 1024, 3 * 1024 * 1024, 32 * 1024 * 1024 - 1024]) {
  test(`instruction edit event-loop measurements with ${size} bytes`, async () => {
    const measure = async (writeEditedHome: typeof updateBotHome) => {
      const f = await makeStore(undefined, writeEditedHome)
      const created = await f.create()
      if (!("json" in created)) throw new Error("Expected bot response")
      const { bot } = created.json as { bot: { id: string } }
      const samples: Array<number> = []
      const intervalMs = 1
      const startedAt = performance.now()
      let expectedAt = startedAt + intervalMs
      let timer: ReturnType<typeof setTimeout> | undefined
      // This bounded timer probe mutates local state so each callback can record its drift sample.
      const sample = () => {
        const actualAt = performance.now()
        samples.push(Math.max(0, actualAt - expectedAt))
        if (samples.length >= 10_000) return
        expectedAt = actualAt + intervalMs
        timer = setTimeout(sample, intervalMs)
      }
      timer = setTimeout(sample, intervalMs)
      cleanups.add(() => {
        if (timer) clearTimeout(timer)
      })

      const response = await f.routes.handler({
        params: { id: bot.id },
        query: {},
        body: { instructions: "x".repeat(size) },
        signal: new AbortController().signal,
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      if (timer) clearTimeout(timer)
      expect(response.status).toBe(200)
      return {
        p99Ms: getPercentile(samples, 0.99),
        maxMs: getMaximum(samples),
        durationMs: performance.now() - startedAt,
        samples: samples.length,
      }
    }
    const synchronousShim: typeof updateBotHome = async (kernel, botId, instructions, _signal, prepare) => {
      const edit = prepare()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 35)
      atomicWriteFile({
        root: kernel.paths.appData,
        path: join(kernel.paths.botsDir, botId, "SOUL.md"),
        content: instructions,
      })
      edit.commit()
    }
    const asynchronousShim = getSlowInstructionEditor(35)

    const before = await measure(synchronousShim)
    const after = await measure(asynchronousShim)
    console.info(
      `Instruction edit event-loop delay, synthetic 35 ms filesystem shim: synchronous p99/max ${before.p99Ms.toFixed(1)}/${before.maxMs.toFixed(1)} ms; asynchronous ${after.p99Ms.toFixed(1)}/${after.maxMs.toFixed(1)} ms`,
    )

    console.info(
      `Instruction edit probe: Bun ${Bun.version}; ${size} bytes; concurrency 1; 1 ms timers; synchronous ${before.samples} samples in ${before.durationMs.toFixed(1)} ms; asynchronous ${after.samples} samples in ${after.durationMs.toFixed(1)} ms`,
    )

    expect(before.maxMs).toBeGreaterThanOrEqual(25)
    expect(after.samples).toBeGreaterThan(10)
    // Preserve the existing responsiveness budget; larger probes also expose pre-existing SQLite/event publication stalls.
    if (size !== 200 * 1024) return
    expect(after.p99Ms).toBeLessThan(50)
    expect(after.maxMs).toBeLessThan(150)
  })
}

const getSlowInstructionEditor = (delayMs: number, onStarted = () => {}): typeof updateBotHome => {
  return async (kernel, botId, instructions, signal, prepare) => {
    const writer = createBotHomeWriter({
      root: kernel.paths.appData,
      createHelper: () => {
        const helper = startBotHomeHelper(kernel.paths.appData)
        return {
          execute: async (command) => {
            onStarted()
            await Bun.sleep(delayMs)
            await helper.execute(command)
          },
          stop: helper.stop,
        }
      },
    })
    cleanups.add(writer.close)
    await updateBotHome(kernel, botId, instructions, signal, prepare, writer)
  }
}

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-home-store-"))
  roots.push(root)
  return root
}

const getRecordingKernel = (kernel: Kernel, failLog = false) => {
  // Recording this injected boundary keeps diagnostics assertions independent of log files.
  const logs: Array<Parameters<Kernel["log"]>[0]> = []
  const log: Kernel["log"] = (entry) => {
    logs.push(entry)
    if (failLog) throw new Error("Synthetic log storage failure")
  }

  return { kernel: { ...kernel, log }, getLogs: () => logs }
}

const makeStartupStore = async (instructions: string) => {
  const fixture = await makeStore()
  const created = await fixture.create()
  if (!("json" in created)) throw new Error("Expected bot response")
  const { bot } = created.json as { bot: { id: string } }
  fixture.database.query("UPDATE bots SET instructions = ? WHERE id = ?").run(instructions, bot.id)
  await fixture.stop()
  const home = join(fixture.root, "bots", bot.id)
  await rm(join(home, "SOUL.md"))
  const runtime = createKernel({ appData: fixture.root })
  cleanups.add(runtime.stop)

  return { runtime, database: runtime.kernel.db as Database, home, botId: bot.id, root: fixture.root }
}

const makeStore = async (writeHome?: typeof writeBotHome, writeEditedHome?: typeof updateBotHome) => {
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
  await initStore(kernel, undefined, undefined, writeHome, writeEditedHome)
  cleanups.add(() => stopBotHomeWriter(kernel))
  const module = modules.find((module) => module.name === "store")
  const getRoute = (method: string, path: string) => {
    const route = module?.routes.find((route) => route.method === method && route.path === path)
    if (!route) throw new Error("Missing store route")
    return route
  }
  const create = (signal = new AbortController().signal) =>
    getRoute("POST", "/bots").handler({ params: {}, query: {}, body: { name: "Fixture", provider: "claude" }, signal })
  const stop = async () => {
    await stopBotHomeWriter(kernel)
    await runtime.stop()
  }
  return { root, database: kernel.db as Database, create, routes: getRoute("PATCH", "/bots/:id"), stop }
}
