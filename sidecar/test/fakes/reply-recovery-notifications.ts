import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createNotificationStore } from "../../src/notify/store"
import { createWorkState } from "../../src/runtime/work-state"

const [directory, identity] = process.argv.slice(2)
if (!directory || !identity) throw new Error("Missing synthetic recovery fixture")
const { threadId, botId } = JSON.parse(identity) as { threadId: string; botId: string }
// One-shot fixture runs only while its disposable server is stopped.
const database = new Database(join(directory, "touri.db"))
const now = Date.now()
database
  .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,queued_at,finished_at)
  VALUES ('interrupted-reply',?,?,'codex','user','interrupted','app_restart',?,?)`)
  .run(threadId, botId, now, now)
const work = createWorkState({ database, now: () => now })
work.beginEffect({
  turnId: "interrupted-reply",
  threadId,
  key: "preview",
  description: "Prévia fictícia pendente de revisão",
  effectId: "preview-effect",
})
const { notification } = createNotificationStore({ db: database }).insert({
  kind: "turn-failed",
  botId,
  threadId,
  requestId: "recovery:run:interrupted-reply",
  title: "Tarefa interrompida",
  body: "A resposta foi interrompida.",
})
database
  .query("INSERT INTO recovery_tasks VALUES(?,?,?)")
  .run("run:interrupted-reply", notification.id, "interrupted-reply")
work.recover({ observe: () => ({ kind: "unobservable", reason: "Synthetic unknown outcome" }) })
database.close()
