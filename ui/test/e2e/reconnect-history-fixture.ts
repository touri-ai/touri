import { Database } from "bun:sqlite"
import { join } from "node:path"

const [dataDir, threadId, personName] = process.argv.slice(2)
if (!dataDir || !threadId) throw new Error("Synthetic history requires a data directory and conversation")
const db = new Database(join(dataDir, "touri.db"))
const now = Date.now()
const messages = Array.from({ length: 60 }, (_, index) => ({
  id: `restart-history-${index}`,
  parentId: index === 0 ? null : `restart-history-${index - 1}`,
  text: `Registro fictício ${index}: uma conversa de teste que permanece aberta durante a reconexão.`,
  at: now + index,
}))

// Bounded synthetic startup fixture, before the browser opens; no requests share this transaction.
db.transaction(() => {
  messages.forEach((message) => {
    db.query(
      "INSERT INTO messages(id,thread_id,parent_id,role,kind,status,text,created_at,updated_at) VALUES(?,?,?,'user','text','complete',?,?,?)",
    ).run(message.id, threadId, message.parentId, message.text, message.at, message.at)
  })
  db.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(messages.at(-1)?.id, threadId)
})()
db.close()

if (personName) {
  // Browser evidence must use a synthetic display name rather than the host account's name.
  const auth = new Database(join(dataDir, "auth.db"))
  auth.query("UPDATE people SET name = ? WHERE id = 'owner'").run(personName)
  auth.close()
}
