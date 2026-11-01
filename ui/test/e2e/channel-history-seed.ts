import { constants, Database } from "bun:sqlite"
import { join } from "node:path"
import { newId } from "../../../sidecar/src/kernel/ids"

const [directory, encodedIds, firstTitle] = process.argv.slice(2)
if (!directory || !encodedIds || !["1", "2"].includes(firstTitle ?? ""))
  throw new Error("Missing synthetic channel fixture")
const threadIds: unknown = JSON.parse(encodedIds)
if (!Array.isArray(threadIds) || threadIds.length > 3 || !threadIds.every((id) => typeof id === "string"))
  throw new Error("Invalid synthetic channel fixture")

// At most 132 legacy conversations, seeded only while the disposable server is stopped.
const database = new Database(
  join(directory, "touri.db"),
  constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW,
)
const insert = database.query(
  "INSERT INTO threads (id, bot_id, group_id, kind, title, owner_person_id, created_at, updated_at) SELECT ?, bot_id, group_id, 'chat', ?, owner_person_id, ?, ? FROM threads WHERE id = ? AND group_id IS NOT NULL AND parent_thread_id IS NULL AND group_thread_id IS NULL",
)
database.transaction(() => {
  threadIds.forEach((threadId) => {
    Array.from({ length: 44 }, (_, index) => index + Number(firstTitle)).forEach((index) => {
      const timestamp = Date.now()
      const result = insert.run(newId(), `Conversa ${index}`, timestamp, timestamp, threadId)
      if (result.changes !== 1) throw new Error("Missing synthetic channel root")
    })
  })
})()
database.close()
