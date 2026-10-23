import { Database } from "bun:sqlite"
import { join } from "node:path"

const [directory, threadId] = process.argv.slice(2)
if (!directory || !threadId) throw new Error("Missing synthetic workspace fixture")
// One-shot synthetic seed: server is stopped and owns this disposable directory.
const database = new Database(join(directory, "touri.db"))
database
  .query(`INSERT INTO messages(id,thread_id,role,kind,status,text,created_at,updated_at)
  VALUES ('preview-message',?,'assistant','text','complete','O caderno fictício está pronto.',1,1)`)
  .run(threadId)
database.query("UPDATE threads SET active_leaf_id = 'preview-message' WHERE id = ?").run(threadId)
database.close()
