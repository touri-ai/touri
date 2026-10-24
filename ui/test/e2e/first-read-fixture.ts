import { Database } from "bun:sqlite"
import { join } from "node:path"

const [dataDir, threadId] = process.argv.slice(2)
if (!dataDir || !threadId) throw new Error("Synthetic first-read fixture needs its own directory and thread")
const db = new Database(join(dataDir, "touri.db"))
db.exec("PRAGMA journal_mode=DELETE")
const now = Date.now()
const bot = db.query("SELECT provider FROM bots LIMIT 1").get() as { provider: string }
// One-shot, offline synthetic workload matching the QA's cardinalities and mostly free pages.
db.transaction(() => {
  for (let index = 1; index < 16; index++) {
    db.query("INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(
      `synthetic-bot-${index}`,
      `Equipe fictícia ${index}`,
      bot.provider,
      join(dataDir, `synthetic-bot-${index}`),
      now,
      now,
    )
    db.query(
      "INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at) VALUES (?,?,'#558866','cercle','fixture',?,?)",
    ).run(`synthetic-group-${index}`, `Canal fictício ${index}`, now, now)
  }
  for (let index = 0; index < 182; index++)
    db.query(
      "INSERT INTO threads(id,bot_id,group_id,group_thread_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(
      `synthetic-thread-${index}`,
      `synthetic-bot-${(index % 15) + 1}`,
      index < 46 ? `synthetic-group-${(index % 15) + 1}` : null,
      index >= 20 && index < 46 ? `synthetic-thread-${index % 20}` : null,
      `Histórico fictício ${index}`,
      now,
      now,
    )
  for (let index = 0; index < 2488; index++) {
    const selected = index < 60
    const id = `first-read-${index}`
    const text = selected
      ? `Registro fictício ${index}. ${"Histórico preservado. ".repeat(22)}`
      : `Histórico fictício ${index}. ${"Histórico sintético. ".repeat(210)}`
    db.query(
      "INSERT INTO messages(id,thread_id,parent_id,role,kind,status,text,parts_json,created_at,updated_at) VALUES (?,?,?,'user','text','complete',?,?,?,?)",
    ).run(
      id,
      selected ? threadId : `synthetic-thread-${index % 182}`,
      selected && index ? `first-read-${index - 1}` : null,
      text,
      JSON.stringify([{ type: "text", text }]),
      now + index,
      now + index,
    )
  }
  db.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run("first-read-59", threadId)
  for (let index = 0; index < 724; index++)
    db.query(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at) VALUES (?, ?, ?, ?, 'user', 'succeeded', ?)",
    ).run(
      `synthetic-run-${index}`,
      `synthetic-thread-${index % 182}`,
      `synthetic-bot-${(index % 15) + 1}`,
      bot.provider,
      now + index,
    )
})()
// Allocate then free real pages; a sparse/truncated file would not represent the fragmented QA copy.
db.exec("CREATE TABLE synthetic_ballast (payload BLOB)")
for (let index = 0; index < 102; index++) db.exec("INSERT INTO synthetic_ballast VALUES (zeroblob(20000000))")
db.exec("DROP TABLE synthetic_ballast; PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)")
console.log(
  JSON.stringify({ pages: db.query("PRAGMA page_count").get(), free: db.query("PRAGMA freelist_count").get() }),
)
db.close()
const auth = new Database(join(dataDir, "auth.db"))
auth.query("UPDATE people SET name = 'Pessoa fictícia' WHERE id = 'owner'").run()
auth.close()
