import { afterEach, expect, test } from "bun:test"
import type { Bot } from "@touri/contracts"
import { createCloudBotUpdates } from "../../src/cloud/bot-updates"

const cleanups = new Set<() => void>()
afterEach(() => {
  Array.from(cleanups)
    .reverse()
    .forEach((cleanup) => {
      cleanup()
    })
  cleanups.clear()
})

const getBot = (name: string, instructionsDeferred = true): Bot =>
  ({
    id: "fixture",
    name,
    instructions: instructionsDeferred ? "" : name,
    instructionsHash: `hash-${name}`,
    instructionsDeferred,
    machine: "cloud",
  }) as Bot

test("a delayed instruction read cannot let an older remote update overwrite a newer one", async () => {
  const reading = Promise.withResolvers<void>()
  const release = Promise.withResolvers<{ instructions: string }>()
  cleanups.add(() => release.resolve({ instructions: "first" }))
  const reads = new Map<string, string | undefined>()
  const sent = new Map<string, string>()
  const updates = createCloudBotUpdates({
    getInstructions: async ({ botId, instructionsHash }) => {
      reads.set(instructionsHash ?? "", botId)
      if (instructionsHash !== "hash-first") return "latest"
      reading.resolve()
      return (await release.promise).instructions
    },
    send: async (bot) => {
      sent.set(bot.name, bot.instructions)
    },
  })
  cleanups.add(updates.dispose)
  updates.save(getBot("first"))
  await reading.promise

  updates.save(getBot("superseded"))
  updates.save(getBot("latest"))
  expect(sent.size).toBe(0)
  release.resolve({ instructions: "first" })
  await updates.flushAsync()

  expect(Array.from(reads.keys())).toEqual(["hash-first", "hash-latest"])
  expect(Array.from(sent.entries())).toEqual([
    ["first", "first"],
    ["latest", "latest"],
  ])
})

test("remote sends stay serialized even when instruction text is already inline", async () => {
  const sending = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  const sent = new Set<string>()
  const updates = createCloudBotUpdates({
    getInstructions: async () => undefined,
    send: async (bot) => {
      if (bot.name === "first") {
        sending.resolve()
        await release.promise
      }
      sent.add(bot.name)
    },
  })
  cleanups.add(updates.dispose)
  updates.save(getBot("first", false))
  await sending.promise

  updates.save(getBot("latest", false))
  await Promise.resolve()
  expect(sent.size).toBe(0)
  release.resolve()
  await updates.flushAsync()

  expect(Array.from(sent)).toEqual(["first", "latest"])
})

test("a missing instruction revision is skipped and disposal cancels an active send", async () => {
  const sending = Promise.withResolvers<AbortSignal>()
  const sent = new Set<string>()
  const updates = createCloudBotUpdates({
    getInstructions: async () => undefined,
    send: async (bot, signal) => {
      sent.add(bot.name)
      sending.resolve(signal)
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    },
  })
  cleanups.add(updates.dispose)
  updates.save(getBot("stale"))
  await updates.flushAsync()

  updates.save(getBot("inline", false))
  const signal = await sending.promise
  updates.dispose()
  updates.save(getBot("after-disposal", false))
  await updates.flushAsync()

  expect(signal.aborted).toBe(true)
  expect(Array.from(sent)).toEqual(["inline"])
})

test("remote updates admit at most eight active bots and resume waiting bots after a slot opens", async () => {
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanups.add(release.resolve)
  const started = new Set<string>()
  const updates = createCloudBotUpdates({
    getInstructions: async () => undefined,
    send: async (bot) => {
      started.add(bot.id)
      if (started.size === 8) ready.resolve()
      await release.promise
    },
  })
  cleanups.add(updates.dispose)
  Array.from({ length: 9 }, (_, index) =>
    updates.save(Object.assign({}, getBot("inline", false), { id: `bot-${index}` })),
  )
  await ready.promise

  expect(started.size).toBe(8)
  release.resolve()
  await updates.flushAsync()

  expect(started.size).toBe(9)
})
