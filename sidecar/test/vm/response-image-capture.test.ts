import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, MessagePart, VmRuntime } from "@touri/contracts"
import responseImagesSql from "../../src/kernel/migrations/response-image-references.sql" with { type: "text" }
import { createServices } from "../../src/kernel/services"
import { getResponseImagePaths, saveResponseImages } from "../../src/runtime/save-response-images"
import { evidenceImageRoute } from "../../src/vm/evidence-images"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test("captures only prose image references", () => {
  expect(
    getResponseImagePaths("![result](/tmp/result.png)\n```\n/tmp/secret.png\n```\nhttps://example.test/remote.png"),
  ).toEqual(["/tmp/result.png"])
})

test("preserves code-formatted image paths containing spaces", () => {
  const text = "Imagem: `/tmp/example result.png`. Remota: `https://example.test/remote image.png`"

  expect(getResponseImagePaths(text)).toEqual(["/tmp/example result.png"])
})

test("full local bot captures outside its root and retains bytes after source deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-image-capture-"))
  const database = new Database(":memory:")
  cleanups.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  database.exec(
    "CREATE TABLE attachments(id TEXT PRIMARY KEY,path TEXT,mime TEXT,bytes INTEGER,origin_path TEXT,created_at INTEGER)",
  )
  const homeDir = join(root, "bot")
  await mkdir(homeDir)
  const source = join(root, "outside.png")
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
  await writeFile(source, bytes)
  const bot = { id: "bot", machine: "local", access: "full", homeDir, cwd: homeDir, projectId: null } as Bot
  const services = createServices()
  const unexpected = (): never => {
    throw new Error("Unexpected store operation")
  }
  services.provide("store.api", {
    getBot: () => bot,
    insertMessage: unexpected,
    appendDelta: unexpected,
    updateMessage: unexpected,
    activePath: unexpected,
    setActiveLeaf: unexpected,
    getThread: unexpected,
    createThread: unexpected,
    updateThread: unexpected,
    search: unexpected,
  })
  const kernel = {
    db: database,
    services,
    paths: { appData: join(root, "data"), attachmentsDir: join(root, "data", "attachments") },
  } as Kernel
  const parts: MessagePart[] = [{ type: "text", text: `![result](${source})` }]

  const result = await saveResponseImages({ kernel, database, bot, parts })
  await rm(source)

  expect(structuredClone(result[0])).toMatchObject({
    type: "text",
    images: [{ path: source, attachmentId: expect.stringMatching(/^[a-f0-9]{64}$/) }],
  })
  const attachment = database.query("SELECT path FROM attachments").get() as { path: string }
  expect(await readFile(attachment.path)).toEqual(bytes)
  database.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE threads(id TEXT,bot_id TEXT);
    CREATE TABLE messages(id TEXT,thread_id TEXT,parts_json TEXT);
    CREATE TABLE attachment_message_refs(thread_id TEXT,message_id TEXT,attachment_id TEXT,PRIMARY KEY(thread_id,message_id,attachment_id));`)
  database.exec(responseImagesSql)
  expect(database.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toHaveLength(2)
  database.query("INSERT INTO threads VALUES (?,?)").run("thread", bot.id)
  database.query("INSERT INTO messages VALUES (?,?,?)").run("reply", "thread", JSON.stringify(result))
  expect(database.query("SELECT attachment_id FROM attachment_message_refs").all()).toHaveLength(1)
  const reference = database.query("SELECT attachment_id FROM attachment_message_refs").get() as {
    attachment_id: string
  }

  const response = await evidenceImageRoute(kernel, {} as VmRuntime).handler({
    params: { id: bot.id },
    query: { attachmentId: reference.attachment_id },
    body: null,
    signal: new AbortController().signal,
  })

  expect(response.status).toBe(200)
  expect("stream" in response && Buffer.from(await new Response(response.stream).arrayBuffer())).toEqual(bytes)
  database.query("UPDATE messages SET parts_json = '[]' WHERE id = ?").run("reply")
  expect(database.query("SELECT * FROM attachment_message_refs").all()).toEqual([])
})

test("restricted bot cannot capture outside its allowed folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-image-denied-"))
  const database = new Database(":memory:")
  cleanups.push(async () => {
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  const homeDir = join(root, "bot")
  await mkdir(homeDir)
  const source = join(root, "outside.png")
  await writeFile(source, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const bot = { id: "bot", machine: "local", access: "workspace-write", homeDir, cwd: homeDir, projectId: null } as Bot
  const kernel = { paths: { appData: join(root, "data"), attachmentsDir: join(root, "data", "attachments") } } as Kernel
  const parts: MessagePart[] = [{ type: "text", text: `![result](${source})` }]

  expect(await saveResponseImages({ kernel, database, bot, parts })).toEqual(parts)
})
