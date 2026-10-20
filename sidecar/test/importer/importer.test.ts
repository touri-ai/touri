import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, LegacyImportOptions } from "@touri/contracts"
import { init, scheduleLegacyExpiry } from "../../src/importer"
import { DEPRECATED_IMPORT_ALIAS } from "../../src/importer/deprecatedAliases"
import { setImporterFsReadTracker } from "../../src/importer/legacy/fs"
import { sourceOrigin } from "../../src/importer/legacy/identity"
import { cleanupExpiredLegacyStaging, runLegacyImport } from "../../src/importer/legacy/import"
import { buildAllowlistedCopyCommandList } from "../../src/importer/legacy/transport"
import { createKernel } from "../../src/kernel"

const fixtureRoot = join(import.meta.dir, "..", "fixtures", "legacy")

test("A04 hostile SSH dump cannot write a host database, including dry-run", async () => {
  await withImport(async ({ root, kernel }) => {
    const target = join(root, "victim.db")
    const commands: string[] = []
    const hostile: Kernel = {
      ...kernel,
      shellEnv: async () => ({ PATH: "/usr/bin:/bin" }),
      spawnTree: (input) => {
        const command = input.args.at(-1) ?? ""
        commands.push(command)
        const sql = `VACUUM INTO '${target}';`
        return {
          success: true,
          pid: 0,
          pgid: 0,
          extra: [],
          stdin: new WritableStream(),
          stdout: new Blob([command.includes("python3") ? "" : sql]).stream(),
          stderr: new Blob(["snapshot unavailable"]).stream(),
          exited: Promise.resolve({ code: command.includes("python3") ? 1 : 0, signal: null }),
          kill: () => {},
        }
      },
    }
    await expect(
      runLegacyImport({
        kernel: hostile,
        importId: kernel.newId(),
        options: {
          ...optionsFor({ source: "unused", dryRun: true }),
          source: { kind: "ssh", host: "fixture.invalid", user: "test", root: "~/source" },
        },
      }),
    ).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
    expect(commands.some((command) => command.includes(".dump"))).toBe(false)
  })
})

test("A05 source IDs cannot claim existing local bots or threads; origins stay distinct", async () => {
  await withImport(async ({ database, source, root, run, kernel }) => {
    database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('victim','victim','codex','unused',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread-mark-main-0000000000000000000001','victim','private',1,1);
      INSERT INTO messages(id,thread_id,role,kind,text,created_at,updated_at) VALUES ('private','thread-mark-main-0000000000000000000001','user','text','private',1,1);`)
    await run()
    expect(
      database.query("SELECT bot_id FROM threads WHERE id = 'thread-mark-main-0000000000000000000001'").get(),
    ).toEqual({ bot_id: "victim" })
    expect(database.query("SELECT id FROM bots WHERE id = 'bot-mark-000000000000000000000001'").get()).toBeNull()
    const secondSource = join(root, "second-source")
    cpSync(source, secondSource, { recursive: true })
    await runLegacyImport({ kernel, importId: kernel.newId(), options: optionsFor({ source: secondSource }) })
    expect(database.query("SELECT count(*) AS n FROM bots WHERE source = 'legacy'").get()).toEqual({ n: 6 })
  })
})

test("A18 expiry progresses beyond 32 records and clears persisted staging markers", async () => {
  await withImport(async ({ database, kernel }) => {
    for (let index = 0; index < 70; index++) {
      const id = `expired-${index}`
      const path = join(kernel.paths.importsDir, "legacy", id)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, "messages.db"), "private snapshot")
      database
        .query(
          "INSERT INTO imports(id,source,origin,status,report_json,started_at,finished_at) VALUES (?,'legacy','fixture','failed',?,1,?)",
        )
        .run(id, JSON.stringify({ staging: { path, expiresAt: 1 } }), index)
    }
    for (let pass = 0; pass < 4; pass++) await cleanupExpiredLegacyStaging({ kernel, now: 2 })
    expect(
      database.query("SELECT count(*) AS n FROM imports WHERE json_extract(report_json,'$.staging') IS NOT NULL").get(),
    ).toEqual({ n: 0 })
    expect(readdirSync(join(kernel.paths.importsDir, "legacy"))).toHaveLength(0)
  })
})

test("expiry also removes failed staging left under the deprecated staging directory", async () => {
  await withImport(async ({ database, kernel }) => {
    const path = join(kernel.paths.importsDir, DEPRECATED_IMPORT_ALIAS, "old-staging")
    mkdirSync(path, { recursive: true })
    database
      .query(
        "INSERT INTO imports(id,source,origin,status,report_json,started_at) VALUES ('old-staging','legacy','fixture','failed',?,1)",
      )
      .run(JSON.stringify({ staging: { path, expiresAt: 1 } }))
    expect(await cleanupExpiredLegacyStaging({ kernel, now: 2 })).toBe(1)
    expect(existsSync(path)).toBe(false)
  })
})

test("A18 scheduled expiry runs while idle and resumes the persisted cursor", async () => {
  await withImport(async ({ database, kernel }) => {
    for (let index = 0; index < 65; index++) {
      const id = `idle-${index}`
      const path = join(kernel.paths.importsDir, "legacy", id)
      mkdirSync(path, { recursive: true })
      database
        .query(
          "INSERT INTO imports(id,source,origin,status,report_json,started_at) VALUES (?,'legacy','fixture','failed',?,1)",
        )
        .run(id, JSON.stringify({ staging: { path, expiresAt: 1 } }))
    }
    expect(await cleanupExpiredLegacyStaging({ kernel })).toBe(32)
    const stop = scheduleLegacyExpiry({ ...kernel }, 10)
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const remaining = database
          .query("SELECT count(*) AS n FROM imports WHERE json_extract(report_json,'$.staging') IS NOT NULL")
          .get() as { n: number }
        if (!remaining.n) break
        await Bun.sleep(10)
      }
      expect(
        database
          .query("SELECT count(*) AS n FROM imports WHERE json_extract(report_json,'$.staging') IS NOT NULL")
          .get(),
      ).toEqual({ n: 0 })
    } finally {
      stop()
    }
  })
})

test("A05 changed source ownership and generated-ID collisions fail without modifying local objects", async () => {
  await withImport(async ({ database, kernel, source, run }) => {
    await run()
    const victim = importedId(database, source, "thread", "thread-mark-main-0000000000000000000001")
    const botRows = JSON.parse(readFileSync(join(source, "bots.json"), "utf8")) as {
      id: string
      threadId: string
      tasks: unknown[]
    }[]
    const first = botRows[0]
    const second = botRows[1]
    if (!first || !second) throw new Error("Missing fixture bot")
    second.threadId = first.threadId
    writeFileSync(join(source, "bots.json"), JSON.stringify(botRows))
    await expect(run()).rejects.toThrow(/conflicting bot owners/)
    expect(database.query("SELECT bot_id FROM threads WHERE id=?").get(victim)).toEqual({
      bot_id: importedId(database, source, "bot", first.id),
    })
    const otherSource = join(source, "..", "collision-source")
    cpSync(fixtureRoot, otherSource, { recursive: true })
    await expect(
      runLegacyImport({
        kernel: { ...kernel, newId: () => victim },
        importId: kernel.newId(),
        options: optionsFor({ source: otherSource }),
      }),
    ).rejects.toThrow(/collides/)
  })
})

test("A05 attachment collisions never overwrite existing local metadata", async () => {
  await withImport(async ({ database, source, run }) => {
    const content = readFileSync(join(source, "attachments", "valid.png"))
    const id = createHash("sha256").update(content).digest("hex")
    database
      .query("INSERT INTO attachments(id,path,mime,bytes,created_at) VALUES (?,'existing-owned-path','image/jpeg',1,1)")
      .run(id)
    await expect(run()).rejects.toThrow(/attachment collision/)
    expect(database.query("SELECT path,mime,bytes FROM attachments WHERE id=?").get(id)).toEqual({
      path: "existing-owned-path",
      mime: "image/jpeg",
      bytes: 1,
    })
  })
})

test("A04 failed dry-run does not write live import metadata or expiry settings", async () => {
  await withImport(async ({ database, source, run, kernel }) => {
    const db = new Database(join(source, "messages.db"))
    db.exec("DROP TABLE messages")
    db.close()
    // Only import writes belong in the total_changes assertion.
    kernel.services.use("storage.maintenance")?.dispose()
    const changes = database.query("SELECT total_changes() AS n").get()
    await expect(run({ dryRun: true })).rejects.toThrow()
    expect(database.query("SELECT total_changes() AS n").get()).toEqual(changes)
    expect(database.query("SELECT count(*) AS n FROM imports").get()).toEqual({ n: 0 })
  })
})

test("A04 malformed thread-state snapshots do not leak readonly native handles", async () => {
  await withImport(async ({ source, run }) => {
    const sourceDb = new Database(join(source, "messages.db"))
    sourceDb.exec("DROP TABLE thread_state")
    sourceDb.close()
    const before = readdirSync("/dev/fd").length
    for (let attempt = 0; attempt < 8; attempt++) await expect(run()).rejects.toThrow(/thread_state/)
    expect(readdirSync("/dev/fd").length).toBeLessThanOrEqual(before + 2)
  })
})
const unselectedRoutineFixture = join(fixtureRoot, "routines-unselected-run.json")

const tempRoot = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

const copyFixture = (root: string): string => {
  const source = join(root, "source")
  cpSync(fixtureRoot, source, { recursive: true })
  return source
}

const importedId = (database: Database, source: string, kind: string, id: string): string => {
  const row = database
    .query("SELECT local_id FROM import_records WHERE source='legacy-identity-v1' AND source_id=?")
    .get(JSON.stringify([sourceOrigin({ kind: "local", root: source }), kind, id])) as { local_id: string } | null
  if (!row) throw new Error("Missing mapped import ID")
  return row.local_id
}
const importedMessage = (database: Database, source: string, thread: string, id: string) =>
  importedId(database, source, "message", JSON.stringify([thread, id]))

const optionsFor = ({
  source,
  dryRun = false,
  importCodexSessions = false,
}: {
  source: string
  dryRun?: boolean
  importCodexSessions?: boolean
}): LegacyImportOptions => ({
  source: { kind: "local", root: source },
  botIds: [],
  importCodexSessions,
  cwdMap: [{ from: "/home/user/javascript/MyApp", to: "/tmp/touri-myapp" }],
  includeAttachments: true,
  dryRun,
})

const withImport = async <T>(
  callback: (args: {
    root: string
    source: string
    database: Database
    kernel: ReturnType<typeof createKernel>["kernel"]
    run: (options?: Partial<LegacyImportOptions>) => ReturnType<typeof runLegacyImport>
  }) => Promise<T>,
): Promise<T> => {
  const root = tempRoot("touri-wp8-test-")
  const source = copyFixture(root)
  const runtime = createKernel({ appData: join(root, "app") })
  const database = runtime.kernel.db as Database
  const run = (overrides: Partial<LegacyImportOptions> = {}) =>
    runLegacyImport({
      kernel: runtime.kernel,
      importId: runtime.kernel.newId(),
      options: { ...optionsFor({ source }), ...overrides, source: { kind: "local", root: source } },
    })
  try {
    return await callback({ root, source, database, kernel: runtime.kernel, run })
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

test("registers the import routes and publishes progress events", async () => {
  const root = tempRoot("touri-wp8-route-")
  const source = copyFixture(root)
  const runtime = createKernel({ appData: join(root, "app") })
  const events: Array<string> = []
  const unsubscribe = runtime.kernel.subscribe((envelope) => {
    if (envelope.event.type === "import.progress") events.push(envelope.event.phase)
  })
  await init(runtime.kernel)
  const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1`
  const headers = {
    Authorization: "Bearer dev-ui-token",
    Origin: "tauri://localhost",
    "Content-Type": "application/json",
  }
  try {
    const started = await fetch(`${url}/imports/legacy`, {
      method: "POST",
      headers,
      body: JSON.stringify(optionsFor({ source })),
    })
    expect(started.status).toBe(202)
    const { importId } = (await started.json()) as { importId: string }
    let current: { status: string; report: { messages: { created: number } } | null } = {
      status: "running",
      report: null,
    }
    for (let attempt = 0; attempt < 100 && current.status === "running"; attempt += 1) {
      const response = await fetch(`${url}/imports/${importId}`, { headers })
      current = (await response.json()) as typeof current
      if (current.status === "running") await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    expect(current.status).toBe("succeeded")
    expect(current.report?.messages.created).toBe(11)
    expect(events).toContain("starting")
    expect(events).toContain("complete")
  } finally {
    unsubscribe()
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("the deprecated import route is a hidden alias of the legacy route", async () => {
  const root = tempRoot("touri-wp8-alias-")
  const source = copyFixture(root)
  const runtime = createKernel({ appData: join(root, "app") })
  await init(runtime.kernel)
  try {
    const started = await fetch(
      `http://127.0.0.1:${runtime.handshake.port}/api/v1/imports/${DEPRECATED_IMPORT_ALIAS}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-ui-token",
          Origin: "tauri://localhost",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(optionsFor({ source, dryRun: true })),
      },
    )
    expect(started.status).toBe(202)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("dry run reports the fixture and leaves the database and target files unchanged", async () => {
  await withImport(async ({ database, root, run }) => {
    const result = await run({ dryRun: true })
    expect(result.report.bots.created).toBe(3)
    expect(result.report.threads.created).toBe(5)
    expect(result.report.messages.created).toBe(11)
    expect(result.report.routines.created).toBe(2)
    expect(result.report.attachments).toMatchObject({ created: 1, updated: 0, unchanged: 0, skipped: 1 })
    expect(result.report.droppedMessageKinds).toEqual({ digest: 1, options: 2 })
    expect(result.perBot["bot-mark-000000000000000000000001"]).toMatchObject({
      routines: 1,
      droppedDigests: 1,
      droppedOptions: 2,
    })
    expect(result.perBot["bot-onb-000000000000000000000002"]).toMatchObject({
      routines: 1,
      droppedDigests: 0,
      droppedOptions: 0,
    })
    expect(result.perBot["bot-panko-000000000000000000000003"]).toMatchObject({
      routines: 0,
      droppedDigests: 0,
      droppedOptions: 0,
    })
    expect(database.query("SELECT count(*) AS count FROM bots").get()).toEqual({ count: 0 })
    expect(database.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 0 })
    expect(database.query("SELECT count(*) AS count FROM imports").get()).toEqual({ count: 0 })
    expect(existsSync(join(root, "app", "bots", "bot-mark-000000000000000000000001", "SOUL.md"))).toBe(false)
    expect(existsSync(join(root, "app", "imports", "legacy", result.report.importId))).toBe(false)
  })
})

test("real import maps message trees, drops digest/options, copies attachments and disables routines/computer use", async () => {
  await withImport(async ({ database, root, source, run }) => {
    const result = await run()
    expect(result.report.messages.created).toBe(11)
    expect(database.query("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 11 })
    expect(
      database
        .query("SELECT parent_id FROM messages WHERE id = ?")
        .get(importedMessage(database, source, "thread-mark-main-0000000000000000000001", "m04")),
    ).toEqual({ parent_id: importedMessage(database, source, "thread-mark-main-0000000000000000000001", "m02") })
    expect(
      database
        .query("SELECT active_leaf_id FROM threads WHERE id = ?")
        .get(importedId(database, source, "thread", "thread-panko-task-0000000000000000000005")),
    ).toEqual({ active_leaf_id: importedMessage(database, source, "thread-panko-task-0000000000000000000005", "m13") })
    expect(database.query("SELECT computer_use FROM bots WHERE name = 'mark'").get()).toEqual({ computer_use: 0 })
    expect(database.query("SELECT enabled FROM routines").all()).toEqual([{ enabled: 0 }, { enabled: 0 }])
    expect(database.query("SELECT trigger_source FROM routine_runs").get()).toEqual({ trigger_source: "import" })
    expect(database.query("SELECT external_turn_id FROM runs").get()).toEqual({ external_turn_id: "turn-1" })
    expect(
      database
        .query("SELECT request_message_id FROM runs WHERE id = ?")
        .get(importedId(database, source, "run", "turn-1")),
    ).toEqual({
      request_message_id: importedMessage(database, source, "thread-mark-main-0000000000000000000001", "m01"),
    })
    const imageMessage = database
      .query("SELECT parts_json FROM messages WHERE id = ?")
      .get(importedMessage(database, source, "thread-panko-main-0000000000000000000004", "m11")) as {
      parts_json: string
    }
    expect(imageMessage.parts_json).toContain('"type":"image"')
    expect(result.report.warnings.some((warning) => warning.includes("outside attachments"))).toBe(true)
    const attachment = database.query("SELECT path, origin_path FROM attachments").get() as {
      path: string
      origin_path: string
    }
    expect(attachment.path.endsWith(".png")).toBe(true)
    expect(attachment.origin_path).toBe("attachments/valid.png")
    expect(existsSync(attachment.path)).toBe(true)
    expect(
      readFileSync(
        join(root, "app", "bots", importedId(database, source, "bot", "bot-mark-000000000000000000000001"), "SOUL.md"),
        "utf8",
      ),
    ).toContain("You are mark")
    expect(
      existsSync(
        join(
          root,
          "app",
          "bots",
          importedId(database, source, "bot", "bot-mark-000000000000000000000001"),
          "memory",
          "log",
          "2026-10-12.md",
        ),
      ),
    ).toBe(true)
    expect(existsSync(join(root, "app", "imports", "legacy", result.report.importId))).toBe(false)
    expect(source).toContain("source")
  })
})

test("skips routine runs whose routine belongs outside the selected bot scope", async () => {
  await withImport(async ({ database, source, run }) => {
    cpSync(unselectedRoutineFixture, join(source, "routines.json"))
    const result = await run({ botIds: ["mark"] })
    expect(result.report.routines).toMatchObject({ created: 1, skipped: 1 })
    expect(database.query("SELECT id, routine_id FROM routine_runs").all()).toEqual([
      {
        id: importedId(database, source, "routine_run", "routine-run-mark-000000000000000000001"),
        routine_id: importedId(database, source, "routine", "routine-mark-0000000000000000000001"),
      },
    ])
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
  })
})

test("includes the child and parent IDs when a foreign key failure reaches the CLI path", async () => {
  await withImport(async ({ run }) => {
    await expect(
      run({
        cwdMap: [{ from: "/home/user/javascript/MyApp", to: "/tmp/touri-myapp", projectId: "missing-project" }],
      }),
    ).rejects.toThrow(
      /FOREIGN KEY constraint failed; bots\[rowid=\d+\]\.project_id="missing-project" references projects\.id="missing-project"/,
    )
  })
})

test("re-import is idempotent and two appended source messages are created", async () => {
  await withImport(async ({ database, source, run }) => {
    await run()
    const second = await run()
    expect(second.report.bots).toMatchObject({ created: 0, updated: 0, unchanged: 3 })
    expect(second.report.threads).toMatchObject({ created: 0, updated: 0, unchanged: 5 })
    expect(second.report.messages).toMatchObject({ created: 0, updated: 0, unchanged: 11 })
    const sourceDatabase = new Database(join(source, "messages.db"))
    sourceDatabase
      .query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "thread-mark-main-0000000000000000000001",
        "m15",
        1760000000020,
        "user",
        "text",
        "New one",
        JSON.stringify({ id: "m15", at: 1760000000020, parentId: "m05", role: "user", kind: "text", text: "New one" }),
      )
    sourceDatabase
      .query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "thread-mark-main-0000000000000000000001",
        "m16",
        1760000000021,
        "bot",
        "text",
        "New two",
        JSON.stringify({ id: "m16", at: 1760000000021, parentId: "m15", role: "bot", kind: "text", text: "New two" }),
      )
    sourceDatabase.close()
    const third = await run()
    expect(third.report.messages.created).toBe(2)
    expect(database.query("SELECT count(*) AS count FROM messages").get()).toEqual({ count: 13 })
  })
})

test("R11-REG-09 re-importing a source first imported before origin-scoped identities does not duplicate it", async () => {
  await withImport(async ({ database, run }) => {
    const first = await run()
    const counts = () =>
      ["bots", "threads", "messages", "routines", "routine_runs"].map(
        (table) => (database.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
      )
    const before = counts()
    const scoped = database
      .query("SELECT source_kind, source_id, local_id FROM import_records WHERE source = 'legacy-identity-v1'")
      .all() as Array<{ source_kind: string; source_id: string; local_id: string }>
    database.exec("DELETE FROM import_records")
    const insert = database.query(
      "INSERT OR IGNORE INTO import_records(source, source_kind, source_id, local_id, content_hash, import_id, imported_at) VALUES ('legacy', ?, ?, ?, '', ?, 1)",
    )
    for (const row of scoped) {
      const [, , sourceId] = JSON.parse(row.source_id) as [string, string, string]
      const legacyId = row.source_kind === "message" ? (JSON.parse(sourceId) as string[]).join(":") : sourceId
      insert.run(row.source_kind, legacyId, row.local_id, first.report.importId)
    }
    await run()
    expect(counts()).toEqual(before)
    expect(
      (
        database.query("SELECT count(*) AS n FROM import_records WHERE source = 'legacy-identity-v1'").get() as {
          n: number
        }
      ).n,
    ).toBeGreaterThan(0)
  })
})

test("local SOUL edits and locally enabled routines survive re-import", async () => {
  await withImport(async ({ database, root, source, run }) => {
    await run()
    const soulPath = join(
      root,
      "app",
      "bots",
      importedId(database, source, "bot", "bot-mark-000000000000000000000001"),
      "SOUL.md",
    )
    writeFileSync(soulPath, "Local SOUL edit\n")
    database
      .query("UPDATE routines SET enabled = 1 WHERE id = ?")
      .run(importedId(database, source, "routine", "routine-mark-0000000000000000000001"))
    const result = await run()
    expect(result.report.warnings.some((warning) => warning.includes("local SOUL.md edit kept"))).toBe(true)
    expect(readFileSync(soulPath, "utf8")).toBe("Local SOUL edit\n")
    expect(
      database
        .query("SELECT instructions FROM bots WHERE id = ?")
        .get(importedId(database, source, "bot", "bot-mark-000000000000000000000001")),
    ).toEqual({ instructions: "Local SOUL edit\n" })
    expect(
      database
        .query("SELECT enabled FROM routines WHERE id = ?")
        .get(importedId(database, source, "routine", "routine-mark-0000000000000000000001")),
    ).toEqual({ enabled: 1 })
  })
})

test("allowlist never includes decoy credential paths and optional Codex sessions are imported", async () => {
  const commands = buildAllowlistedCopyCommandList({
    source: { kind: "ssh", user: "user", host: "host.example", root: "~/.legacy-app" },
    botNames: [{ id: "bot-mark", name: "mark" }],
    attachmentBasenames: ["valid.png"],
    sessionFilenames: ["$HOME/.codex/sessions/2026/rollout-mark-fixture.jsonl"],
  })
  expect(commands.every((command) => !/config\.json|sessions\.json|hook-tokens|credential|auth/i.test(command))).toBe(
    true,
  )
  await withImport(async ({ database, run }) => {
    const result = await run({ importCodexSessions: true })
    expect(result.report.codexSessions.created).toBe(1)
    expect(database.query("SELECT fingerprint FROM provider_sessions").get()).toEqual({ fingerprint: "imported" })
  })
})

test("the importer never reads any decoy source path", async () => {
  await withImport(async ({ source, run }) => {
    const reads: Array<{ operation: string; path: string }> = []
    const decoys = [
      join(source, "config.json"),
      join(source, "sessions.json"),
      join(source, "hook-tokens"),
      join(source, "browser-engine-key"),
      join(source, "webhooks.json"),
      join(source, "events"),
      join(source, "native"),
      join(source, "tool-results"),
      join(source, "checkpoints"),
      join(source, "memory-journal"),
      join(source, "messages.db.bak-20261012"),
    ]
    setImporterFsReadTracker((operation, path) => reads.push({ operation, path }))
    try {
      await run({ dryRun: true })
    } finally {
      setImporterFsReadTracker(null)
    }
    for (const decoy of decoys)
      expect(reads.some(({ path }) => path === decoy || path.startsWith(`${decoy}/`))).toBe(false)
  })
})

test("source symlinks are rejected before bots.json or messages.db is opened", async () => {
  await withImport(async ({ source, root, run }) => {
    const outsideBots = join(root, "outside-bots.json")
    writeFileSync(outsideBots, readFileSync(join(source, "bots.json")))
    rmSync(join(source, "bots.json"))
    symlinkSync(outsideBots, join(source, "bots.json"))
    const botReads: Array<string> = []
    setImporterFsReadTracker((_operation, path) => botReads.push(path))
    try {
      await expect(run()).rejects.toThrow(/Missing required source file bots.json/)
    } finally {
      setImporterFsReadTracker(null)
    }
    expect(botReads.some((path) => path === outsideBots)).toBe(false)

    rmSync(join(source, "bots.json"))
    writeFileSync(join(source, "bots.json"), readFileSync(outsideBots))
    const outsideDatabase = join(root, "outside-messages.db")
    writeFileSync(outsideDatabase, readFileSync(join(source, "messages.db")))
    rmSync(join(source, "messages.db"))
    symlinkSync(outsideDatabase, join(source, "messages.db"))
    const databaseReads: Array<string> = []
    setImporterFsReadTracker((_operation, path) => databaseReads.push(path))
    try {
      await expect(run()).rejects.toThrow(/messages.db must be a regular file/)
    } finally {
      setImporterFsReadTracker(null)
    }
    expect(databaseReads.some((path) => path === outsideDatabase)).toBe(false)
  })
})

test("failed staging is retained with seven-day metadata and bounded expiry cleanup", async () => {
  await withImport(async ({ database, root, kernel, source, run }) => {
    const sourceDatabase = new Database(join(source, "messages.db"))
    sourceDatabase.exec("DROP TABLE messages")
    sourceDatabase.close()
    const startedAt = Date.now()
    await expect(run()).rejects.toThrow(/no such table: messages/)
    const row = database
      .query("SELECT id, status, report_json FROM imports ORDER BY started_at DESC LIMIT 1")
      .get() as { id: string; status: string; report_json: string }
    const report = JSON.parse(row.report_json) as {
      staging: { path: string; expiresAt: number }
      warnings: Array<string>
    }
    expect(row.status).toBe("failed")
    expect(report.staging.path).toBe(join(root, "app", "imports", "legacy", row.id))
    expect(report.staging.expiresAt).toBeGreaterThanOrEqual(startedAt + 7 * 24 * 60 * 60 * 1000)
    expect(existsSync(report.staging.path)).toBe(true)
    expect(statSync(report.staging.path).mode & 0o777).toBe(0o700)
    expect(report.warnings.some((warning) => warning.includes(report.staging.path))).toBe(true)
    expect(await cleanupExpiredLegacyStaging({ kernel, now: report.staging.expiresAt + 1 })).toBe(1)
    expect(existsSync(report.staging.path)).toBe(false)
  })
})

test("attachments from an unselected bot thread are not staged or imported", async () => {
  await withImport(async ({ database, source, run }) => {
    const sourceDatabase = new Database(join(source, "messages.db"))
    const row = sourceDatabase.query("SELECT json FROM messages WHERE id = 'm09'").get() as { json: string }
    const message = JSON.parse(row.json) as { attachments?: Array<Record<string, string>> }
    message.attachments = [{ kind: "image", path: "attachments/unselected.png", mime: "image/png" }]
    sourceDatabase.query("UPDATE messages SET json = ? WHERE id = 'm09'").run(JSON.stringify(message))
    sourceDatabase.close()
    writeFileSync(join(source, "attachments", "unselected.png"), "unselected")
    const result = await run({ botIds: ["bot-mark-000000000000000000000001"] })
    expect(result.report.attachments).toEqual({ created: 0, updated: 0, unchanged: 0, skipped: 0 })
    expect(result.perBot["bot-mark-000000000000000000000001"]).toMatchObject({ attachments: 0 })
    expect(database.query("SELECT count(*) AS count FROM attachments").get()).toEqual({ count: 0 })
  })
})

test("A02: imported attachments cannot choose an active MIME or disguise HTML as raster", async () => {
  await withImport(async ({ source, database, run }) => {
    const input = new Database(join(source, "messages.db"))
    const rows = input.query("SELECT id,json FROM messages WHERE json LIKE '%valid.png%'").all() as Array<{
      id: string
      json: string
    }>
    for (const row of rows) {
      const value = JSON.parse(row.json) as { attachments?: Array<{ mime: string }> }
      for (const attachment of value.attachments ?? []) attachment.mime = "image/svg+xml"
      input.query("UPDATE messages SET json = ? WHERE id = ?").run(JSON.stringify(value), row.id)
    }
    input.close()
    writeFileSync(join(source, "attachments", "valid.png"), "<svg onload=alert(1) />")
    await run()
    const attachments = database.query("SELECT mime FROM attachments").all() as Array<{ mime: string }>
    expect(attachments.length).toBeGreaterThan(0)
    expect(attachments.every((item) => item.mime === "application/octet-stream")).toBe(true)
  })
})

test("attachment paths must be exactly attachments/<basename>", async () => {
  await withImport(async ({ database, source, run }) => {
    const sourceDatabase = new Database(join(source, "messages.db"))
    const row = sourceDatabase.query("SELECT json FROM messages WHERE id = 'm09'").get() as { json: string }
    const message = JSON.parse(row.json) as { attachments?: Array<Record<string, string>> }
    message.attachments = [
      { kind: "image", path: "foo/attachments/image.png", mime: "image/png" },
      { kind: "image", path: "foo\\\\attachments\\\\image.png", mime: "image/png" },
      { kind: "image", path: "/attachments/image.png", mime: "image/png" },
      { kind: "image", path: "attachments/../image.png", mime: "image/png" },
    ]
    sourceDatabase.query("UPDATE messages SET json = ? WHERE id = 'm09'").run(JSON.stringify(message))
    sourceDatabase.close()
    const result = await run()
    expect(result.report.attachments).toMatchObject({ created: 1, skipped: 5 })
    expect(database.query("SELECT count(*) AS count FROM attachments").get()).toEqual({ count: 1 })
    expect(result.report.warnings.filter((warning) => warning.includes("outside attachments")).length).toBe(5)
  })
})

test("a source WAL transaction can remain open while a consistent snapshot is imported", async () => {
  await withImport(async ({ database, source, run }) => {
    const sourceDatabase = new Database(join(source, "messages.db"))
    sourceDatabase.exec("BEGIN IMMEDIATE")
    sourceDatabase.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "thread-mark-main-0000000000000000000001",
      "uncommitted",
      1760000000030,
      "user",
      "text",
      "uncommitted",
      JSON.stringify({
        id: "uncommitted",
        at: 1760000000030,
        parentId: null,
        role: "user",
        kind: "text",
        text: "uncommitted",
      }),
    )
    const result = await run({ dryRun: true })
    expect(result.report.messages.created).toBe(11)
    expect(database.query("SELECT count(*) AS count FROM bots").get()).toEqual({ count: 0 })
    sourceDatabase.exec("ROLLBACK")
    sourceDatabase.close()
  })
})

test("ssh source dry run streams a read-only dump and never writes on the remote", async () => {
  const root = tempRoot("touri-wp8-ssh-")
  const source = copyFixture(root)
  const bin = join(root, "bin")
  const commandLog = join(root, "ssh-commands.log")
  mkdirSync(bin)
  writeFileSync(
    join(bin, "ssh"),
    `#!/bin/sh\nfor last; do :; done\nprintf '%s\\n' "$last" >> ${JSON.stringify(commandLog)}\nexec /bin/sh -c "$last"\n`,
  )
  chmodSync(join(bin, "ssh"), 0o755)
  const before = readdirSync(source).sort()
  const runtime = createKernel({ appData: join(root, "app") })
  const environment = await runtime.kernel.shellEnv()
  const kernel = {
    ...runtime.kernel,
    shellEnv: async () => ({ ...environment, PATH: `${bin}:${environment.PATH ?? ""}` }),
  }
  try {
    const result = await runLegacyImport({
      kernel,
      importId: runtime.kernel.newId(),
      options: {
        ...optionsFor({ source, dryRun: true }),
        source: { kind: "ssh", user: "user", host: "fixture.invalid", root: source },
      },
    })
    expect(result.report.bots.created).toBe(3)
    expect(result.report.messages.created).toBe(11)
    expect(readdirSync(source).sort()).toEqual(before)
    const commands = readFileSync(commandLog, "utf8")
    expect(commands).not.toMatch(/VACUUM|\brm\b|\bmv\b|\bcp\b|>|\btee\b/)
    expect(commands).toMatch(/serialize|\.dump/)
    expect(commands).not.toMatch(/config\.json|sessions\.json|hook-tokens/)
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test("absolute attachment paths under <root>/attachments are accepted by basename", async () => {
  await withImport(async ({ database, source, run }) => {
    const sourceDatabase = new Database(join(source, "messages.db"))
    const row = sourceDatabase.query("SELECT json FROM messages WHERE id = 'm09'").get() as { json: string }
    const message = JSON.parse(row.json) as { attachments?: Array<Record<string, string>> }
    message.attachments = [{ kind: "image", path: "/home/user/source/attachments/valid.png", mime: "image/png" }]
    sourceDatabase.query("UPDATE messages SET json = ? WHERE id = 'm09'").run(JSON.stringify(message))
    sourceDatabase.close()
    const result = await run()
    expect(result.report.warnings.filter((warning) => warning.includes("source/attachments/valid.png"))).toEqual([])
    expect(database.query("SELECT count(*) AS count FROM attachments").get()).toEqual({ count: 1 })
  })
})

test("expiry advances bounded rowid windows past malformed and non-object reports", async () => {
  await withImport(async ({ database, kernel }) => {
    const insert = database.query(`INSERT INTO imports(id,source,origin,status,report_json,started_at)
      VALUES (?,'legacy','fixture','failed',?,1)`)
    const invalidReports = ["null", "[]", '"text"', "{}", "{"]
    invalidReports.forEach((report, index) => {
      insert.run(`invalid-${index}`, report)
    })
    const path = join(kernel.paths.importsDir, "legacy", "expired-valid")
    mkdirSync(path, { recursive: true })
    insert.run("expired-valid", JSON.stringify({ staging: { path, expiresAt: 1 } }))

    const first = await cleanupExpiredLegacyStaging({ kernel, now: 2, maxEntries: 2 })
    const second = await cleanupExpiredLegacyStaging({ kernel, now: 2, maxEntries: 2 })
    const third = await cleanupExpiredLegacyStaging({ kernel, now: 2, maxEntries: 2 })

    expect([first, second, third]).toEqual([0, 0, 1])
    expect(existsSync(path)).toBe(false)
    expect(database.query("SELECT report_json FROM imports WHERE id='expired-valid'").get()).toEqual({
      report_json: "{}",
    })
  })
})
