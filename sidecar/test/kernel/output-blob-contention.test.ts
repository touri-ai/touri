import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { externalizeMessagePartsAsync } from "../../src/kernel/output-blobs"

const cleanups = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanups).reduceRight(async (previous, cleanup) => {
    await previous
    await cleanup()
  }, Promise.resolve())
  cleanups.clear()
})

test("output attachment publication yields to a competing writer without losing its reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-output-contention-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const database = openDatabase({ filename: join(root, "test.db") })
  cleanups.add(() => database.close())
  database.exec("PRAGMA busy_timeout = 0")
  const writer = new Database(database.filename)
  cleanups.add(() => writer.close())
  writer.exec("BEGIN IMMEDIATE")
  const getStatement = database.query.bind(database)
  const queries = spyOn(database, "query").mockImplementation((sql) => {
    const isAttachmentWrite = sql.includes("INSERT OR IGNORE INTO attachments") || sql === "PRAGMA busy_timeout"
    if (writer.inTransaction && isAttachmentWrite)
      queueMicrotask(() => {
        if (writer.inTransaction) writer.exec("COMMIT")
      })

    return getStatement(sql)
  })
  cleanups.add(() => {
    queries.mockRestore()
  })
  const output = "synthetic retained output\n".repeat(512)

  const parts = await externalizeMessagePartsAsync({
    database,
    appData: root,
    parts: [
      {
        type: "command",
        callId: "command",
        command: "sample",
        cwd: "/workspace",
        exitCode: null,
        resolution: "cancelled_by_user",
        outputTail: output,
      },
    ],
  })

  const command = parts[0]
  if (command?.type !== "command" || !command.outputAttachmentId) throw new Error("Output reference missing")
  const attachment = getStatement("SELECT path FROM attachments WHERE id = ?").get(command.outputAttachmentId) as {
    path: string
  } | null
  if (!attachment) throw new Error("Output attachment missing")
  expect(writer.inTransaction).toBe(false)
  expect(command.outputTail).toBe("")
  expect(await Bun.file(attachment.path).text()).toBe(output)
})
