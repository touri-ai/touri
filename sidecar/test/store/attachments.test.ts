import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Attachment, Message } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { MAX_ATTACHMENT_BYTES } from "../../src/kernel/files"
import { csvInput } from "../../src/runtime/csv-input"
import { init } from "../../src/store"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-attachment-qa-"))
  const runtime = createKernel({ appData: root })
  cleanup.push(() => {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  await init(runtime.kernel)
  const db = runtime.kernel.db as Database
  db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Anexos',1,1);`)
  const store = runtime.kernel.services.use("store.api")
  if (!store?.sendMessage) throw new Error("Store missing")
  const request = (path: string, method = "GET", body?: unknown) =>
    fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  return { runtime, store, request }
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvN8AAAAASUVORK5CYII=",
  "base64",
)

test("a device CSV upload becomes real provider data without any folder grant", async () => {
  const f = await fixture()
  const content = "cadastro,valor\nregistro-a,12\nregistro-b,30\n"
  const uploaded = await f.request("/attachments", "POST", {
    name: "cadastros.csv",
    dataBase64: Buffer.from(content).toString("base64"),
  })
  expect(uploaded.status).toBe(201)
  const { attachment } = (await uploaded.json()) as { attachment: Attachment }
  const sent = await f.request("/threads/t/messages", "POST", {
    threadId: "t",
    parentId: null,
    text: "Some os valores.",
    attachmentIds: [attachment.id],
    clientNonce: "csv-upload",
  })
  // This fixture is offline: the message is journaled for the runtime to resume.
  expect(sent.status).toBe(503)
  const { messages } = (await (await f.request("/threads/t/messages?all=true")).json()) as { messages: Message[] }
  const parts = messages[0]?.parts ?? []
  expect(parts).toContainEqual(
    expect.objectContaining({ type: "file", name: "cadastros.csv", attachmentId: attachment.id }),
  )
  const input = csvInput({ kernel: f.runtime.kernel, parts })
  expect(input[0]?.text).toContain(JSON.stringify({ name: "cadastros.csv", content }))
  expect(f.store.getBot({ botId: "b" })).toMatchObject({ folders: [], anyFolderAccess: false })
})

test("common small text, Markdown, JSON, CSV, PDF and image uploads retain their bytes", async () => {
  const f = await fixture()
  for (const [name, content] of [
    ["teste.txt", Buffer.from("conteúdo")],
    ["teste.md", Buffer.from("# Plano")],
    ["teste.json", Buffer.from('{"ok":true}')],
    ["teste.csv", Buffer.from("a,b\n1,2")],
    ["teste.pdf", Buffer.from("%PDF-1.4\n%%EOF")],
    ["teste.png", png],
  ] as const) {
    const uploaded = await f.request("/attachments", "POST", { name, dataBase64: content.toString("base64") })
    expect(uploaded.status).toBe(201)
    const { attachment } = (await uploaded.json()) as { attachment: Attachment }
    const download = await f.request(`/attachments/${attachment.id}`)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(content)
  }
})

test("sent attachment names and IDs survive history reload and an edited sibling prompt", async () => {
  const f = await fixture()
  const ids: string[] = []
  for (const [name, content] of [
    ["teste-anexo.txt", Buffer.from("notas")],
    ["teste-imagem.png", png],
  ] as const) {
    const uploaded = await f.request("/attachments", "POST", { name, dataBase64: content.toString("base64") })
    ids.push(((await uploaded.json()) as { attachment: Attachment }).attachment.id)
  }
  // Offline sends still persist the authoritative parts; no runtime or provider is started.
  for (const [clientNonce, text] of [
    ["original", "Confira os anexos"],
    ["edited", "Confira os anexos novamente"],
  ]) {
    await f.request("/threads/t/messages", "POST", {
      threadId: "t",
      parentId: null,
      text,
      attachmentIds: ids,
      clientNonce,
    })
  }
  const [textId, imageId] = ids
  if (!textId || !imageId) throw new Error("Missing uploaded attachments")
  const history = await f.request("/threads/t/messages?all=true")
  const { messages } = (await history.json()) as { messages: Message[] }
  expect(messages).toHaveLength(2)
  for (const message of messages) {
    expect(message.parentId).toBeNull()
    expect(message.parts.filter((part) => part.type === "file" || part.type === "image")).toEqual([
      { type: "file", attachmentId: textId, name: "teste-anexo.txt", mime: "application/octet-stream" },
      { type: "image", attachmentId: imageId, name: "teste-imagem.png", mime: "image/png" },
    ])
  }
  expect(f.store.activePath({ threadId: "t" }).at(-1)?.id).toBe("send:edited")
  f.store.setActiveLeaf({ threadId: "t", leafId: "send:original" })
  expect(f.store.activePath({ threadId: "t" }).at(-1)?.text).toBe("Confira os anexos")
})

test("oversized attachment content is rejected with the size limit", async () => {
  const f = await fixture()
  const response = await f.request("/attachments", "POST", {
    name: "grande.pdf",
    dataBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64"),
  })
  expect(response.status).toBe(413)
  expect(await response.json()).toMatchObject({
    errorCode: "ATTACHMENT_TOO_LARGE",
    code: "TOURI-E2003",
    error: "Escolha um arquivo de até 15 MB.",
  })
})

test("indexing legacy attachment references yields while conversation history loads", async () => {
  const f = await fixture()
  const database = f.runtime.kernel.db as Database
  const total = 2048
  const insert =
    database.query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    VALUES (?,'t','user','text','complete','Synthetic history',?,1,1)`)
  database.transaction(() => {
    Array.from({ length: total }, (_, index) => index).forEach((index) => {
      insert.run(
        `legacy-${index}`,
        JSON.stringify([{ type: "file", attachmentId: `file-${index}`, name: "test.txt", mime: "text/plain" }]),
      )
    })
    database.exec("DELETE FROM attachment_message_refs")
  })()
  let interleaved = false
  const startedAt = performance.now()
  let previousSample = startedAt
  let samples: Array<number> = []
  const timer = setInterval(() => {
    const sampledAt = performance.now()
    samples = [...samples.slice(-511), Math.max(0, sampledAt - previousSample - 1)]
    previousSample = sampledAt
    const row = database.query("SELECT count(*) AS count FROM attachment_message_refs").get() as { count: number }
    if (row.count > 0 && row.count < total) interleaved = true
  }, 1)
  cleanup.push(() => clearInterval(timer))

  const response = await f.request("/threads/t/messages?all=true")
  // The supported ES2022 target needs a fresh copy for this local probe's sort.
  const sorted = samples.slice().sort((left, right) => left - right)
  console.info(
    JSON.stringify({
      probe: "legacy-attachment-index",
      messages: total,
      intervalMs: 1,
      windowMs: performance.now() - startedAt,
      samples: sorted.length,
      p99Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.99) - 1)] ?? 0,
      maxMs: sorted.at(-1) ?? 0,
    }),
  )

  expect(response.status).toBe(200)
  expect(interleaved).toBe(true)
  expect(database.query("SELECT count(*) AS count FROM attachment_message_refs").get()).toEqual({ count: total })
})

test("one message with many tool output files yields between reference batches", async () => {
  const f = await fixture()
  const database = f.runtime.kernel.db as Database
  const total = 4096
  const parts = Array.from({ length: total }, (_, index) => ({
    type: "command",
    outputAttachmentId: `output-${index}`,
  }))
  database
    .query(`INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at)
    VALUES ('large-output','t','assistant','text','complete','Synthetic output',?,1,1)`)
    .run(JSON.stringify(parts))
  database.exec("DELETE FROM attachment_message_refs")
  let interleaved = false
  const timer = setInterval(() => {
    const row = database.query("SELECT count(*) AS count FROM attachment_message_refs").get() as { count: number }
    if (row.count > 0 && row.count < total) interleaved = true
  }, 1)
  cleanup.push(() => clearInterval(timer))

  const response = await f.request("/threads/t/messages?all=true")

  expect(response.status).toBe(200)
  expect(interleaved).toBe(true)
  expect(database.query("SELECT count(*) AS count FROM attachment_message_refs").get()).toEqual({ count: total })
})
