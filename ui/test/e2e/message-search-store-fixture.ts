import { Database } from "bun:sqlite"
import { join } from "node:path"

const [directory, threadId, scenario] = process.argv.slice(2)
if (!directory || !threadId) throw new Error("Synthetic message history requires a conversation")
const database = new Database(join(directory, "touri.db"))
const text = "nota-qa.txt: resposta antiga completa. Conteúdo fictício preservado até o fim da resposta."
const messages = Array.from({ length: 240 }, (_, index) => ({
  id: `real-search-${index}`,
  parentId: index === 0 ? null : `real-search-${index - 1}`,
  text: index === 8 ? text : `Registro fictício ${index}: acompanhando a revisão.`,
  createdAt: 1_790_000_000_000 + index * 60_000,
}))

// The synthetic server is stopped while this bounded fixture prepares its disposable store.
database.transaction(() => {
  messages.forEach((message) => {
    database
      .query(
        "INSERT INTO messages(id,thread_id,parent_id,role,kind,status,text,parts_json,created_at,updated_at) VALUES(?,?,?,'assistant','text','complete',?,?,?,?)",
      )
      .run(
        message.id,
        threadId,
        message.parentId,
        message.text,
        JSON.stringify([{ type: "text", text: message.text }]),
        message.createdAt,
        message.createdAt,
      )
  })
  database
    .query(
      "INSERT INTO messages(id,thread_id,parent_id,role,kind,status,text,parts_json,created_at,updated_at) VALUES(?,?,?,'assistant','text','complete',?,'[]',?,?)",
    )
    .run(
      "real-search-other-branch",
      threadId,
      "real-search-3",
      "Outra ramificação fictícia.",
      1_790_100_000_000,
      1_790_100_000_000,
    )
  database
    .query("UPDATE threads SET active_leaf_id = ? WHERE id = ?")
    .run(scenario === "branch" ? "real-search-other-branch" : "real-search-239", threadId)
})()
database.close()
