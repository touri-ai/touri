import { Database } from "bun:sqlite"
import { join } from "node:path"

const [directory, ...threadIds] = process.argv.slice(2)
if (!directory || !threadIds.length) throw new Error("Synthetic history fixture requires isolated threads")
const database = new Database(join(directory, "touri.db"))
const now = Date.now() - 5000
// One-shot setup with the isolated server stopped; no request shares this synthetic transaction.
database.transaction(() => {
  threadIds.forEach((threadId) => {
    const thread = database.query("SELECT bot_id FROM threads WHERE id = ?").get(threadId) as { bot_id: string }
    const provider = database.query("SELECT provider FROM bots WHERE id = ?").get(thread.bot_id) as { provider: string }
    Array.from({ length: 2500 }, (_, index) => index).forEach((turn) => {
      database
        .query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,started_at,finished_at,request_message_id,reply_message_id)
        VALUES(?,?,?,?,'user','succeeded',?,?,?,?,?)`)
        .run(
          `history-run-${threadId}-${turn}`,
          threadId,
          thread.bot_id,
          provider.provider,
          now + turn * 2,
          now + turn * 2,
          now + turn * 2 + 1,
          `history-${threadId}-${turn * 2}`,
          `history-${threadId}-${turn * 2 + 1}`,
        )
    })
    Array.from({ length: 5000 }, (_, index) => index).forEach((index) => {
      const text = `Registro fictício ${index}: ${index % 2 ? "O documento de demonstração foi conferido." : "Confira o documento de demonstração."}`
      const parts =
        index % 2
          ? [
              {
                type: "tool_call",
                callId: `fixture-${index}`,
                tool: "read_file",
                summary: "Conferir documento fictício",
                inputJson: '{"path":"/fixture/document.txt"}',
                outputJson: JSON.stringify({ text: "Documento fictício conferido. ".repeat(index >= 4960 ? 1400 : 1) }),
                ok: true,
                resolution: "succeeded",
                resolvedAt: now + index,
              },
              { type: "text", text },
            ]
          : []
      database
        .query(`INSERT INTO messages(id,thread_id,parent_id,role,kind,status,run_id,text,parts_json,created_at,updated_at,seq,generation,updated_seq)
        VALUES(?,?,?,?,'text','complete',?,?,?,?,?,?,1,?)`)
        .run(
          `history-${threadId}-${index}`,
          threadId,
          index ? `history-${threadId}-${index - 1}` : null,
          index % 2 ? "assistant" : "user",
          `history-run-${threadId}-${Math.floor(index / 2)}`,
          text,
          JSON.stringify(parts),
          now + index,
          now + index,
          index + 1,
          index + 1,
        )
    })
    database.query("UPDATE threads SET active_leaf_id = ? WHERE id = ?").run(`history-${threadId}-4999`, threadId)
    // Completed history includes settled tool results, as a normal terminal transition would persist.
    database
      .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution,resolved_at)
      SELECT run_id,json_extract(parts_json,'$[0].callId'),thread_id,json_extract(parts_json,'$[0]'),'succeeded',updated_at
      FROM messages WHERE thread_id = ? AND role = 'assistant'`)
      .run(threadId)
    database.query("DELETE FROM tool_recovery_pending WHERE thread_id = ?").run(threadId)
  })
  // Materialized fixture history must not be replayed as fresh work when the server restarts.
  database.exec(`UPDATE schema_meta SET value = CAST(COALESCE((SELECT MAX(id) FROM transcript_entries), 0) AS TEXT)
    WHERE key = 'transcript_event_checkpoint'`)
})()
database.close()
const auth = new Database(join(directory, "auth.db"))
auth.query("UPDATE people SET name = 'Pessoa demo' WHERE id = 'owner'").run()
auth.close()
