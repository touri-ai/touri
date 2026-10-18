import type { Database } from "bun:sqlite"
import type { Kernel, Message } from "@touri/contracts"
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
  let count = 0
  // Continuously create distinct background replies, including a superseding revision.
  // The selected conversation stays quiet, as it does when other devices work on the server.
  const timer = setInterval(
    () => {
      for (let j = 0; j < 2; j++) {
        const n = ++count
        const threadId = `memory-thread-${1 + (n % 29)}`
        const text = `${n}: ${"Synthetic background reply. ".repeat(Number(process.env.TOURI_MEMORY_REPLY_REPEATS ?? 2500))}`
        const at = Date.now()
        db.query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
        VALUES (?,?,'assistant','text','complete',?,'[]',?,?)`).run(`memory-message-${n}`, threadId, text, at, at)
        const message: Message = {
          id: `memory-message-${n}`,
          threadId,
          parentId: null,
          role: "assistant",
          kind: "text",
          status: "complete",
          text,
          parts: [{ type: "text", text }],
          createdAt: at,
          updatedAt: at,
          source: "native",
          runId: null,
        }
        kernel.publish({ type: "message.created", message: { ...message, status: "streaming" } })
        kernel.publish({ type: "message.updated", message })
      }
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
