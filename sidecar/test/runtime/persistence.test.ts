import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Run } from "@touri/contracts"
import { publicError } from "@touri/contracts"
import { openDatabase } from "../../src/kernel/db"
import { createRuntimePersistence, toRun } from "../../src/runtime/persistence"

test.each(["machine_service_unavailable", "machine_service_start_failed", "group_context_missing"] as const)(
  "%s persists on the shipped schema and remains terminal after reopening",
  (errorClass) => {
    const root = mkdtempSync(join(tmpdir(), "touri-machine-persistence-"))
    const filename = join(root, "touri.db")
    let db = openDatabase({ filename })
    try {
      db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
        INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);`)
      const writer = createRuntimePersistence({ database: db })
      for (const [index, errorMessage] of ["private XPC failure", "", null].entries()) {
        const run: Run = {
          id: `r-${index}`,
          requesterPersonId: null,
          threadId: "t",
          botId: "b",
          provider: "codex",
          trigger: "user",
          requestMessageId: null,
          replyMessageId: null,
          externalTurnId: null,
          status: "starting",
          errorClass: null,
          errorMessage: null,
          usage: null,
          routineRunId: null,
          queuedAt: 1,
          startedAt: 2,
          finishedAt: null,
        }
        expect(writer.saveRun(run)).toBe(true)
        const failure = { ...run, status: "failed" as const, errorClass, errorMessage, finishedAt: 3 }
        expect(writer.saveRun(failure)).toBe(true)
        // Exercise the SQL decoder also used by send-journal acknowledgements.
        expect(toRun(db.query("SELECT * FROM runs WHERE id = ?").get(run.id))).toEqual(failure)
      }
      db.close()
      db = openDatabase({ filename })
      const reader = createRuntimePersistence({ database: db })
      expect(reader.listActiveRuns()).toEqual([])
      expect(reader.listQueuedRuns()).toEqual([])
      expect(reader.listRuns("t")).toHaveLength(3)
      for (const run of reader.listRuns("t")) {
        expect(run).toMatchObject({ status: "failed", errorClass, finishedAt: 3 })
        expect(publicError(run.errorClass).code).toBe(publicError(errorClass).code)
        expect(reader.getRun(run.id)).toEqual(run)
        expect(reader.saveRun({ ...run, status: "succeeded", errorClass: null, finishedAt: 4 })).toBe(false)
        expect(reader.getRun(run.id)).toEqual(run)
      }
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.each([
  ["cli_crash", '{"code":"TOURI-E8001","message":"provider detail"}'],
  ["unknown", "private failure mentioning TOURI-E8001"],
  ["unknown", '{"code":"TOURI-E8001","message":123}'],
  ["unknown", '{"code":"TOURI-E3002","message":"provider detail"}'],
  ["unknown", '{"code":"TOURI-E1002","message":"legacy invalid request"}'],
  ["unknown", '{"code":"constructor","message":"legacy detail"}'],
  ["unknown", '{"code":"__proto__","message":"legacy detail"}'],
  ["unknown", '{"code":"TOURI-E1002","errorClass":"group_context_missing","message":123}'],
  ["unknown", '{"code":"TOURI-E3002","errorClass":"group_context_missing","message":"legacy detail"}'],
] as const)("legacy %s error retains its detail: %s", (errorClass, errorMessage) => {
  expect(toRun({ error_class: errorClass, error_message: errorMessage })).toMatchObject({ errorClass, errorMessage })
})

test("full run history keeps legacy failures beyond the default 50-run window", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-run-history-"))
  const db = openDatabase({ filename: join(root, "touri.db") })
  try {
    db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('b','Teste','codex','/tmp',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('t','b','Conversa',1,1);`)
    const insert =
      db.query(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,error_class,error_message,queued_at,finished_at)
      VALUES (?,'t','b','codex','user',?,?,?,?,?)`)
    const cause = "O login na máquina não ficou pronto em 15 s"
    for (let index = 0; index < 55; index++)
      insert.run(
        `r-${index}`,
        index === 0 ? "failed" : "succeeded",
        index === 0 ? "timeout" : null,
        index === 0 ? cause : null,
        index,
        index + 1,
      )
    const reader = createRuntimePersistence({ database: db })
    expect(reader.listRuns("t")).toHaveLength(50)
    expect(reader.listRuns("t").some((run) => run.id === "r-0")).toBe(false)
    const all = reader.listRuns("t", { all: true })
    expect(all).toHaveLength(55)
    expect(all.at(-1)).toMatchObject({ id: "r-0", status: "failed", errorMessage: cause })
    expect(all.at(-2)).toMatchObject({ id: "r-1", status: "succeeded" })
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
