import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createNotificationStore } from "../../src/notify/store"

const [directory, identity, phase] = process.argv.slice(2)
if (!directory || !identity) throw new Error("Missing synthetic notification fixture")
const { threadId, failedBotId, successfulBotId } = JSON.parse(identity) as {
  threadId: string
  failedBotId: string
  successfulBotId: string
}
// This one-shot fixture only touches its disposable database while the server is stopped.
const database = new Database(join(directory, "touri.db"))
const now = Date.now()
if (phase === "failure") {
  database
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,queued_at,finished_at)
    VALUES ('brisa-failure',?,?,'codex','user','failed','oom',?,?)`)
    .run(threadId, failedBotId, now - 2000, now - 1000)
  database
    .query(`INSERT INTO messages(id,thread_id,role,kind,status,run_id,parts_json,created_at,updated_at)
    VALUES ('brisa-message',?,'assistant','text','failed','brisa-failure',?,?,?)`)
    .run(
      threadId,
      JSON.stringify([{ type: "file_change", callId: "notes", paths: ["notas-ficticias.md"], diff: null }]),
      now - 2000,
      now - 1000,
    )
  createNotificationStore({ db: database }).insert({
    kind: "turn-failed",
    botId: failedBotId,
    threadId,
    requestId: "recovery:run:brisa-failure",
    title: "Brisa parou antes de terminar",
    body: "A tarefa fictícia precisa de atenção. Abra a conversa para continuar.",
  })
}
if (phase === "success")
  database
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,finished_at)
    VALUES ('oceano-success',?,?,'codex','user','succeeded',?,?)`)
    .run(threadId, successfulBotId, now, now + 1)

database.close()
