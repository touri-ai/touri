import type { Database } from "bun:sqlite"
import { afterEach, expect, mock, test } from "bun:test"
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ReportInput,
  type ReportSnapshot,
  redactReportText,
  redactReportValue,
  reportParts,
  reportSizeLimit,
  reportZip,
} from "@touri/contracts"
import { createFakeCloud } from "../../../test/fakes/fake-cloud"
import { createCloudClient } from "../../src/cloud/client"
import { initCloud } from "../../src/cloud/module"
import { createKernel } from "../../src/kernel"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"
import { createRedactor } from "../../src/kernel/redact"
import { init as initReports, validateReportInput } from "../../src/reports"
import { buildReport, tailLog } from "../../src/reports/bundle"
import { init as initStore } from "../../src/store"

const cleanup = new Set<() => void | Promise<void>>()
afterEach(async () => {
  await Array.from(cleanup).reduceRight(async (previous, dispose) => {
    await previous
    await dispose()
  }, Promise.resolve())
  cleanup.clear()
})
const input = (): ReportInput => ({
  title: "Falha ao executar",
  happened: "Travou",
  expected: "Concluir",
  steps: "Abrir bot",
  severity: "crash",
  botId: null,
  threadId: null,
  errorCode: "TOURI-E8001",
  parts: reportParts.filter((part) => part !== "transcript"),
  images: [],
  repository: "https://github.com/touri/test",
})
const fixture = async (remove = rm) => {
  const root = mkdtempSync(join(tmpdir(), "touri-report-test-"))
  const runtime = createKernel({ appData: root })
  const dispose = async () => {
    await runtime.stop()
    await remove(root, { recursive: true, force: true })
  }
  cleanup.add(dispose)
  await initReports(runtime.kernel)
  const db = runtime.kernel.db as Database
  runtime.kernel.services.provide("doctor", {
    start: () => undefined,
    dispose: () => undefined,
    settled: async () => undefined,
    snapshot: () => ({
      checkedAt: 123,
      running: false,
      checks: [
        { id: "vm-memory:bot", label: "Memória", status: "pass", ok: true, detail: "VM running; 1536 MiB", fix: null },
        { id: "vm-system", label: "Serviço", status: "pass", ok: true, detail: "Ativo", fix: null },
        { id: "network-openai", label: "Rede", status: "pass", ok: true, detail: "DNS ok", fix: null },
      ],
    }),
  })
  const request = async (method: string, path: string, body?: unknown, token = "dev-ui-token") => {
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-touri-client": "reports-test",
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() }
  }
  return { root, runtime, db, request, dispose }
}

test("report disposal retains its database until asynchronous runtime shutdown finishes", async () => {
  const remove = mock(rm)
  const { runtime, root, dispose } = await fixture(remove)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  cleanup.add(release.resolve)
  runtime.kernel.services.provide("runtime.shutdown", async () => {
    entered.resolve()
    await release.promise
  })

  const disposing = dispose()
  await entered.promise
  expect(remove).not.toHaveBeenCalled()
  expect(await Bun.file(join(root, "touri.db")).exists()).toBe(true)
  release.resolve()
  await disposing

  expect(await Bun.file(join(root, "touri.db")).exists()).toBe(false)
})

test("A14 masks multiline private keys, broader credential labels and non-home paths", async () => {
  const { root, runtime } = await fixture()
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nsynthetic-private-material\nsecond-private-line\n-----END RSA PRIVATE KEY-----"
  writeFileSync(join(root, "logs/sidecar.log"), pem)
  const snapshot = await buildReport(runtime.kernel, {
    ...input(),
    parts: ["logs"],
    happened: `${pem}\ncredential=unknown-value\n/opt/company/private/config\nD:\\Company\\Private\\config`,
  })
  const serialized = JSON.stringify(snapshot)
  for (const marker of [
    "synthetic-private-material",
    "second-private-line",
    "unknown-value",
    "/opt/company",
    "Company",
  ])
    expect(serialized.includes(marker)).toBe(false)
})

test("A14 multiline log masking still decodes escaped registered secrets in JSONL", async () => {
  const { root, runtime } = await fixture()
  const secret = 'synthetic-escaped"credential\\value'
  runtime.kernel.addRedactionValue(secret)
  writeFileSync(
    join(root, "logs/sidecar.log"),
    [JSON.stringify({ api_key: "synthetic-key", msg: secret }), JSON.stringify({ output: secret })].join("\n"),
  )
  const snapshot = await buildReport(runtime.kernel, { ...input(), parts: ["logs"] })
  expect(JSON.stringify(snapshot.logs).includes("synthetic-escaped")).toBe(false)
})

test("A14 transcript exports only selected messages and the chosen branch", async () => {
  const { runtime, db } = await fixture()
  await initStore(runtime.kernel)
  db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','bot','codex','unused',1,1);
    INSERT INTO threads(id,bot_id,title,active_leaf_id,created_at,updated_at) VALUES ('chat','bot','chat','active',1,1);
    INSERT INTO messages(id,thread_id,parent_id,role,kind,text,created_at,updated_at) VALUES ('root','chat',NULL,'user','text','root prose',1,1),('active','chat','root','assistant','text','active prose',2,2),('private-branch','chat','root','assistant','text','inactive prose',3,3);`)
  const selected = {
    ...input(),
    botId: "bot",
    threadId: "chat",
    parts: ["transcript"] as ReportInput["parts"],
    transcriptBranch: "active" as const,
    transcriptMessageIds: ["active"],
  }
  const snapshot = await buildReport(runtime.kernel, selected)
  expect(JSON.stringify(snapshot.report)).toContain("active prose")
  expect(JSON.stringify(snapshot.report)).not.toContain("root prose")
  expect(JSON.stringify(snapshot.report)).not.toContain("inactive prose")
  expect(
    JSON.stringify(
      (
        await buildReport(runtime.kernel, {
          ...selected,
          transcriptBranch: "all",
          transcriptMessageIds: ["private-branch"],
        })
      ).report,
    ),
  ).toContain("inactive prose")
})

test("A14 cloud transcript branch selection is enforced even when a server returns every branch", async () => {
  const { runtime } = await fixture()
  runtime.kernel.services.provide("store.api", {
    getThread: () => ({ id: "chat", botId: "bot", activeLeafId: "active" }),
    getBot: () => ({ machine: "cloud" }),
  } as never)
  runtime.kernel.services.provide("cloud.account", {
    request: async () => ({
      messages: [
        { id: "root", parentId: null, role: "user", text: "root prose" },
        { id: "active", parentId: "root", role: "assistant", text: "active prose" },
        { id: "inactive", parentId: "root", role: "assistant", text: "inactive prose" },
      ],
      activeLeafId: "active",
    }),
  } as never)
  const snapshot = await buildReport(runtime.kernel, {
    ...input(),
    botId: "bot",
    threadId: "chat",
    parts: ["transcript"],
  })
  expect(JSON.stringify(snapshot.report)).toContain("active prose")
  expect(JSON.stringify(snapshot.report)).not.toContain("inactive prose")
})

test("A14 edited redacted preview is frozen and delivery uses its exact reviewed bytes", async () => {
  const { request } = await fixture()
  const original = (await request("POST", "/reports/preview", { ...input(), parts: [] })).body as ReportSnapshot
  const edited = { ...original.report, happened: "Edited readable prose credential=synthetic-credential" }
  const next = (
    await request("POST", "/reports/preview", {
      ...input(),
      parts: [],
      previewEdits: { id: original.id, reportJson: JSON.stringify(edited), logs: {} },
    })
  ).body as ReportSnapshot
  expect(JSON.stringify(next.report)).toContain("Edited readable prose")
  expect(JSON.stringify(next.report)).not.toContain("synthetic-credential")
  expect(next.id).not.toBe(original.id)
  const delivered = await request("POST", `/reports/${next.id}/deliver`, { destination: "zip" })
  expect(Buffer.from(delivered.body.zipBase64, "base64")).toEqual(Buffer.from(reportZip(next)))
})

test("C-09 cloud report delivery requires an advertised reports capability", async () => {
  const { runtime, request } = await fixture()
  runtime.kernel.services.provide("store.settings", () => ({ cloud: true }) as never)
  let uploads = 0
  runtime.kernel.services.provide("cloud.account", {
    connected: async () => true,
    request: async () => ({ protocolVersion: 1, capabilities: ["exec"] }),
    uploadReport: async () => {
      uploads++
      return { id: "uploaded" }
    },
  } as never)
  const snapshot = (await request("POST", "/reports/preview", { ...input(), parts: [] })).body as ReportSnapshot
  expect((await request("GET", "/reports")).body.cloudAvailable).toBe(false)
  expect((await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "cloud" })).status).toBe(401)
  expect(uploads).toBe(0)
})

test.each([
  ["sk-fake-key", "sk-fake-key"],
  ["Bearer fake.access-token", "fake.access-token"],
  ["Authorization: Basic abc==", "abc=="],
  ["Cookie: session=abc; other=xyz", "abc"],
  ["Set-Cookie: login=abc; HttpOnly", "abc"],
  ['{"api_key":"made-up-key"}', "made-up-key"],
  ['{"password":"two words"}', "two words"],
  ["ACCESS_TOKEN=pretend", "pretend"],
  ["foo@example.com", "foo@example.com"],
  ["123.456.789-09", "123.456.789-09"],
  ["12345678909", "12345678909"],
  ["+55 (11) 91234-5678", "91234-5678"],
  ["(11) 3456-7890", "3456-7890"],
  ["1134567890", "1134567890"],
  ["+44 20 7123 4567", "7123 4567"],
  [' {"cpf":12345678909,"phone":5511912345678}', "5511912345678"],
  ["8.8.8.8", "8.8.8.8"],
  ["2001:4860:4860::8888", "2001:4860:4860::8888"],
  ["https://user:pass@example.com", "user:pass"],
])("redacts %s", (text, secret) => expect(redactReportText(text)).not.toContain(secret))
test("keeps private IPs and normal prose, abbreviates home paths, masks nested and escaped registered secrets", () => {
  for (const ip of ["10.0.0.1", "192.168.7.2", "172.16.0.4", "127.0.0.1", "::1", "fd12::1234", "fe80::1"])
    expect(redactReportText(ip)).toBe(ip)
  expect(redactReportText("Salvar relatório no touri")).toBe("Salvar relatório no touri")
  expect(redactReportText("/Users/user/my-app /home/alice/file C:\\Users\\Alice\\work")).toBe("~/my-app ~/file ~\\work")
  const redactor = createRedactor()
  const secret = 'registered"value\nwith-escape'
  redactor.addRedactionValue(secret)
  const redact = (value: string) => redactReportText(value, redactor.redact)
  const content = {
    credentials: { Authorization: "anything", cookie: "hidden", token: "hidden" },
    note: secret,
    encoded: JSON.stringify({ note: secret }),
  }
  const redacted = JSON.stringify(redactReportValue(content, redact))
  expect(redacted).not.toContain("hidden")
  expect(redacted).not.toContain("registered")
  expect(redact(JSON.stringify({ nested: content }))).not.toContain("registered")
})

test("bundle selects diagnostics, bounds logs/runs, excludes contents, redacts all outputs and emits a valid ZIP", async () => {
  const { root, runtime, db } = await fixture()
  db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Secret bot instructions','codex','/Users/alice/bot',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('chat','bot','Private conversation',1,1);
    INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at) VALUES ('message','chat','user','text','MESSAGE_DO_NOT_SEND',1,1);`)
  for (let n = 0; n < 30; n++)
    db.query(
      "INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,error_message,queued_at,started_at,finished_at) VALUES (?,?,?,'codex','user','failed','cli_crash','ERROR_MESSAGE_DO_NOT_SEND',?,?,?)",
    ).run(`run-${n}`, "chat", "bot", n, n + 10, n + 30)
  runtime.kernel.addRedactionValue("custom-kernel-secret")
  writeFileSync(
    join(root, "logs/sidecar.log"),
    `${Array.from({ length: 510 }, (_, n) => `line-${n} TOURI-E8001 sk-fake-key custom-kernel-secret`).join("\n")}\n`,
  )
  writeFileSync(join(root, "logs/sidecar-shell.log"), "Cookie: session=fake-cookie\n")
  writeFileSync(join(root, "logs/sidecar-stderr.log"), "Authorization: Bearer fake-token\n/Users/alice/project\n")
  const report = await buildReport(runtime.kernel, {
    ...input(),
    title: "Issue foo@example.com",
    happened: "custom-kernel-secret",
  })
  const text = JSON.stringify(report)
  for (const secret of [
    "MESSAGE_DO_NOT_SEND",
    "ERROR_MESSAGE_DO_NOT_SEND",
    "Secret bot instructions",
    "Private conversation",
    "sk-fake-key",
    "custom-kernel-secret",
    "fake-cookie",
    "fake-token",
    "/Users/alice",
    "foo@example.com",
  ])
    expect(text).not.toContain(secret)
  expect(report.logs["sidecar.log"]?.split("\n")).toHaveLength(500)
  expect(report.logs["sidecar.log"]).not.toContain("line-9 ")
  const diagnostics = report.report.diagnostics as {
    runs: Array<{ duration_ms: number }>
    database: { tables: { messages: number } }
    versions: { schema: number }
    errors: { counts: Record<string, number> }
    memory: unknown[]
    doctor: { checks: unknown[] }
  }
  expect(diagnostics.runs).toHaveLength(20)
  expect(diagnostics.runs[0]?.duration_ms).toBe(20)
  expect(diagnostics.database.tables.messages).toBe(1)
  expect(diagnostics.versions.schema).toBe(SCHEMA_VERSION)
  expect(diagnostics.errors.counts["TOURI-E8001"]).toBe(500)
  expect(diagnostics.memory).toHaveLength(3)
  expect(diagnostics.doctor.checks).toHaveLength(3)
  const zip = join(root, "report.zip")
  writeFileSync(zip, reportZip(report))
  expect(Bun.spawnSync(["unzip", "-t", zip]).exitCode).toBe(0)
  const extracted = Bun.spawnSync(["unzip", "-p", zip, "report.json"])
  expect(JSON.parse(extracted.stdout.toString())).toEqual(report.report)
  expect(Bun.spawnSync(["unzip", "-p", zip, "logs/sidecar.log"]).stdout.toString()).toBe(
    report.logs["sidecar.log"] ?? "",
  )
  const small = await buildReport(runtime.kernel, { ...input(), parts: [] })
  expect(small.logs).toEqual({})
  expect(small.report.diagnostics).toEqual({})
})

test("transcript requires explicit opt-in and redacts selected content", async () => {
  const { runtime, request } = await fixture()
  await initStore(runtime.kernel)
  const bot = (await request("POST", "/bots", { name: "Example", provider: "codex" })).body.bot
  const threadId = bot.mainThreadId
  ;(runtime.kernel.db as Database)
    .query(
      "INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at) VALUES ('message',?,'user','text','Selected conversation sk-fake-key',1,1)",
    )
    .run(threadId)
  ;(runtime.kernel.db as Database).query("UPDATE threads SET active_leaf_id='message' WHERE id=?").run(threadId)
  const selected = { ...input(), botId: bot.id, threadId, parts: ["transcript"] as ReportInput["parts"] }
  const report = await buildReport(runtime.kernel, selected)
  expect(JSON.stringify(report.report)).toContain("Selected conversation [REDACTED]")
  expect(JSON.stringify(await buildReport(runtime.kernel, { ...selected, parts: [] }))).not.toContain(
    "Selected conversation",
  )
  expect(validateReportInput({ ...selected, threadId: null })).toBe(false)
})

test("route authenticates, validates, freezes preview, delivers exact bytes and persists bounded history", async () => {
  const { runtime, request, root, db } = await fixture()
  expect((await request("GET", "/reports", undefined, "wrong")).status).toBe(401)
  expect((await request("POST", "/reports/preview", { ...input(), title: "" })).status).toBe(400)
  expect(
    (await request("POST", "/reports/preview", { ...input(), images: [{ mime: "image/png", dataBase64: "nope" }] }))
      .status,
  ).toBe(400)
  const preview = await request("POST", "/reports/preview", { ...input(), parts: ["logs"], title: "Issue sk-fake-key" })
  expect(preview.status).toBe(200)
  const snapshot = preview.body as ReportSnapshot
  runtime.kernel.log({ level: "error", module: "test", msg: "log added after preview" })
  const exported = await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "zip", title: "tampered" })
  expect(exported.status).toBe(200)
  expect(Buffer.from(exported.body.zipBase64, "base64")).toEqual(Buffer.from(reportZip(snapshot)))
  expect((await request("GET", "/reports")).body.history).toEqual([])
  expect((await request("POST", `/reports/${snapshot.id}/saved`, { destination: "zip" })).status).toBe(200)
  expect((await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "cloud" })).status).toBe(401)
  expect((await request("POST", "/reports/missing/deliver", { destination: "zip" })).status).toBe(404)
  const github = await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "github" })
  const url = new URL(github.body.url)
  expect(url.searchParams.get("body")).toBe(snapshot.summary)
  expect(github.body.url).not.toContain("logs")
  expect(github.body.url).not.toContain("sk-fake-key")
  expect((await request("GET", "/reports")).body.cloudAvailable).toBe(false)
  const rows = (await request("GET", "/reports")).body.history
  expect(rows[0]).toMatchObject({ id: snapshot.id, title: "Issue [REDACTED]", destination: "zip" })
  const pending = Array.from({ length: 100 }, (_, n) => ({
    id: `offline-${n}`,
    date: Date.now(),
    title: "CPF 123.456.789-09",
    destination: "zip",
  }))
  expect((await request("POST", "/reports/history", { history: pending })).status).toBe(200)
  expect((await request("GET", "/reports")).body.history).toHaveLength(100)
  expect(JSON.stringify((await request("GET", "/reports")).body.history)).not.toContain("123.456")
  expect(
    (await request("POST", "/reports/history", { history: [{ ...pending[0], destination: "cloud" }] })).status,
  ).toBe(400)
  expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  const reopened = openDatabase({ filename: join(root, "touri.db") })
  expect(reopened.query("SELECT count(*) AS count FROM problem_reports").get()).toEqual({ count: 100 })
  reopened.close()
})

test("upload uses authenticated multipart with idempotent report IDs, not JSON, and rejects oversize", async () => {
  const { runtime, request } = await fixture()
  await initStore(runtime.kernel)
  const fake = createFakeCloud()
  cleanup.add(() => fake.stop())
  await request("PATCH", "/settings", { cloud: true, cloudBaseUrl: fake.baseUrl })
  const vault = new Map<string, string>()
  runtime.kernel.callHost = (async (method: string, params: { account: string; value: string }) => {
    if (method === "keychain.set") {
      vault.set(params.account, params.value)
      return { success: true, value: {} }
    }
    if (method === "keychain.get") return { success: true, value: { value: vault.get(params.account) ?? null } }
    return { success: false, errorCode: "HOST_UNAVAILABLE", error: "unavailable" }
  }) as typeof runtime.kernel.callHost
  const cloud = initCloud(runtime.kernel)
  cleanup.add(cloud.dispose)
  await cloud.provider.client.store(fake.issueTokens())
  const account = runtime.kernel.services.use("cloud.account")
  if (!account) throw new Error("Missing cloud account")
  const originalRequest = account.request
  account.request = (async (method, path, body, signal) => {
    const value = await originalRequest(method, path, body, signal)
    if (path === "/v1/capabilities") return { ...(value as object), capabilities: ["exec", "reports"] }
    return value
  }) as typeof account.request
  const snapshot = (await request("POST", "/reports/preview", { ...input(), parts: [] })).body as ReportSnapshot
  expect((await request("GET", "/reports")).body.cloudAvailable).toBe(true)
  const first = await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "cloud" })
  expect(first.status).toBe(200)
  const retry = await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "cloud" })
  expect(retry.body.id).toBe(first.body.id)
  expect(fake.calls.filter((call) => call.path === "/v1/reports").every((call) => call.authenticated)).toBe(true)
  expect((await request("GET", "/reports")).body.history[0]).toMatchObject({ id: first.body.id, destination: "cloud" })
  await expect(
    cloud.provider.client.uploadReport(new Uint8Array(reportSizeLimit + 1), "too-large"),
  ).rejects.toBeDefined()
  await expect(cloud.provider.client.uploadReport(new Uint8Array([80, 75, 1, 2]), snapshot.id)).rejects.toMatchObject({
    code: "TOURI-E9000",
  })
  await request("PATCH", "/settings", { cloud: false })
  expect((await request("POST", `/reports/${snapshot.id}/deliver`, { destination: "cloud" })).status).toBe(401)
  const unconnected = createCloudClient(runtime.kernel)
  await expect(unconnected.uploadReport(reportZip(snapshot), "disabled")).rejects.toBeDefined()
})

test("log reads refuse symlinks and preserve the last 500 unterminated lines", async () => {
  const { root } = await fixture()
  const path = join(root, "sample.log")
  writeFileSync(path, Array.from({ length: 501 }, (_, n) => String(n)).join("\n"))
  expect(tailLog(path).split("\n")).toHaveLength(500)
  expect(tailLog(path).split("\n")[0]).toBe("1")
  const symlink = join(root, "link.log")
  symlinkSync(path, symlink)
  expect(tailLog(symlink)).toBe("Log indisponível")
  expect(readFileSync(path, "utf8")).toContain("500")
})

test("preview rejects archives over 10 MB and includes recent API error counts", async () => {
  const { request } = await fixture()
  expect((await request("POST", "/reports/preview", { ...input(), expected: "" })).status).toBe(400)
  const snapshot = (await request("POST", "/reports/preview", { ...input(), parts: ["errors"] })).body as ReportSnapshot
  expect(snapshot.report.diagnostics).toMatchObject({ errors: { requestCounts: { "TOURI-E1001": 1 } } })
  const image = Buffer.alloc(reportSizeLimit / 2)
  image.set([137, 80, 78, 71, 13, 10, 26, 10])
  const body = {
    ...input(),
    parts: [],
    images: [
      { mime: "image/png", dataBase64: image.toString("base64") },
      { mime: "image/png", dataBase64: image.toString("base64") },
    ],
  }
  expect((await request("POST", "/reports/preview", body)).status).toBe(413)
})

test("registered JSON values and escaped registered secrets in raw logs are masked before structural redaction", async () => {
  const { runtime, root } = await fixture()
  const value = 'opaque"private\nvalue'
  const jsonSecret = '{"opaque":"full-registered-json"}'
  runtime.kernel.addRedactionValue(value)
  runtime.kernel.addRedactionValue(jsonSecret)
  writeFileSync(
    join(root, "logs/sidecar.log"),
    `${JSON.stringify({ encoded: JSON.stringify({ value }), exact: jsonSecret })}\n`,
  )
  const report = await buildReport(runtime.kernel, { ...input(), parts: ["logs"] })
  expect(JSON.stringify(report)).not.toContain("opaque")
  expect(JSON.stringify(report)).not.toContain("full-registered-json")
  expect(report.logs["sidecar.log"]).toContain("[REDACTED]")
})
