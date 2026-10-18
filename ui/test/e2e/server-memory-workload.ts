import type { Database } from "bun:sqlite"
import { createInterface } from "node:readline"
import type { Kernel, Message, StoreApi } from "@touri/contracts"
import seed from "../../../sidecar/test/fixtures/ui-seed.json"

export const install = (kernel: Kernel): void => {
  const db = kernel.db as Database
  const provider = seed.bots[0]?.provider
  if (!provider) throw new Error("Missing fixture provider")
  if ((db.query("SELECT count(*) AS n FROM bots").get() as { n: number }).n)
    throw new Error("Memory fixture requires a fresh database")
  for (let i = 0; i < 30; i++) {
    db.query(`INSERT INTO bots(id,name,provider,home_dir,main_thread_id,created_at,updated_at)
      VALUES (?,?,?,?,?,1,1)`).run(`memory-bot-${i}`, `Memory bot ${i}`, provider, "/tmp/fixture", `memory-thread-${i}`)
    db.query("INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES (?,?,?,1,1)").run(
      `memory-thread-${i}`,
      `memory-bot-${i}`,
      `Memory conversation ${i}`,
    )
  }
  const commands = createInterface({ input: process.stdin })
  commands.once("line", (command) => {
    commands.close()
    if (command !== "memory-fixture-start") return

    startMemoryWorkload(kernel)
    console.log("Memory workload started")
  })
}

const startMemoryWorkload = (kernel: Kernel): void => {
  const store = kernel.services.use("store.api")
  if (!store) throw new Error("Memory fixture requires the message store")

  const repeats = Number(process.env.TOURI_MEMORY_REPLY_REPEATS ?? 2500)
  // A local counter gives each timed reply a unique identity.
  let count = 0
  const send = () => {
    count += 1
    saveBackgroundReply(store, getBackgroundMessage(count, repeats))
  }
  const timer = setInterval(
    () => {
      send()
      send()
    },
    Number(process.env.TOURI_MEMORY_EVENT_INTERVAL_MS ?? 1000),
  )
  timer.unref()
  // A manually launched fixture must not keep filling its temporary database after measurement.
  setTimeout(
    () => clearInterval(timer),
    Math.min(600_000, Number(process.env.TOURI_MEMORY_DURATION_MS ?? 15_000) + 60_000),
  ).unref()
}

const saveBackgroundReply = (store: StoreApi, message: Message): void => {
  // Durable revisions exercise the same event delivery path as real replies.
  const inserted = store.insertMessage({ message })
  if (!inserted.success) throw new Error("Could not insert a background reply")

  const updated = store.updateMessage({
    threadId: message.threadId,
    messageId: message.id,
    patch: { status: "complete" },
  })
  if (!updated.success) throw new Error("Could not complete a background reply")
}

const getBackgroundMessage = (index: number, repeats: number, now = Date.now()): Message => {
  const text = `${index}: ${"Synthetic background reply. ".repeat(repeats)}`

  return {
    id: `memory-message-${index}`,
    threadId: `memory-thread-${1 + (index % 29)}`,
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "streaming",
    text,
    parts: [{ type: "text", text }],
    sender: null,
    createdAt: now,
    updatedAt: now,
    source: "local",
    runId: null,
  }
}
