import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createNotificationStore } from "../../src/notify/store"
import { createWorkState } from "../../src/runtime/work-state"

const [directory, identity] = process.argv.slice(2)
if (!directory || !identity) throw new Error("Missing synthetic recovery fixture")
const { threadId, groupId, botId } = JSON.parse(identity) as { threadId: string; groupId: string; botId: string }
// One-shot fixture writes only while the disposable server is stopped.
const database = new Database(join(directory, "touri.db"))
const now = Date.now()
database
  .query(`INSERT INTO threads(id,bot_id,group_thread_id,title,created_at,updated_at)
  VALUES ('member-session',?,?,'Member session',?,?)`)
  .run(botId, threadId, now, now)
const work = createWorkState({ database, now: () => now })
const notifications = createNotificationStore({ db: database })
for (const [id, thread] of [
  ["root-recovery", threadId],
  ["child-recovery", "member-session"],
] as const) {
  database
    .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,queued_at,finished_at)
    VALUES (?,?,?,'codex','user','interrupted','app_restart',?,?)`)
    .run(id, thread, botId, now, now)
  work.beginEffect({
    turnId: id,
    threadId: thread,
    key: `${id}-key`,
    description: id === "root-recovery" ? "Prévia da coordenação" : "Prévia do membro",
    effectId: `${id}-effect`,
  })
  const { notification } = notifications.insert({
    kind: "turn-failed",
    botId,
    threadId,
    requestId: `recovery:run:${id}`,
    title: "Tarefa interrompida",
    body: "A resposta foi interrompida.",
  })
  database.query("INSERT INTO recovery_tasks VALUES(?,?,?)").run(`run:${id}`, notification.id, id)
}
database.query("INSERT INTO group_turns VALUES(?,?,?)").run("root-recovery", groupId, JSON.stringify([botId]))
database.query("INSERT INTO group_run_links VALUES('child-recovery','root-recovery',0)").run()
work.recover({ observe: () => ({ kind: "unobservable", reason: "Synthetic unknown outcome" }) })
database.close()
