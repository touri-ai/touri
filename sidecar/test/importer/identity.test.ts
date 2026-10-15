import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importIdentity } from "../../src/importer/legacy/identity"
import { createKernel } from "../../src/kernel"

const LEGACY_ORIGIN = "ssh://dev@build-host:22"

const withKernel = (
  callback: (args: { kernel: ReturnType<typeof createKernel>["kernel"]; database: Database }) => void,
) => {
  const root = mkdtempSync(join(tmpdir(), "touri-identity-test-"))
  const runtime = createKernel({ appData: join(root, "app") })
  try {
    callback({ kernel: runtime.kernel, database: runtime.kernel.db as Database })
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

const seedUnscopedImport = (database: Database) => {
  database
    .query("INSERT INTO imports(id,source,origin,status,started_at) VALUES ('old-import','legacy',?,'succeeded',1)")
    .run(LEGACY_ORIGIN)
  database
    .query(
      "INSERT INTO import_records(source,source_kind,source_id,local_id,content_hash,import_id,imported_at) VALUES ('legacy','bot','bot-1','adopted-bot','','old-import',1)",
    )
    .run()
}

test("#4 a legacy-proven id is adopted once and then cannot be claimed by a second origin", () => {
  withKernel(({ kernel, database }) => {
    seedUnscopedImport(database)
    const first = importIdentity(kernel, "ssh://dev@build-host:22/srv/a", "import-a", LEGACY_ORIGIN)
    expect(first.id("bot", "bot-1")).toBe("adopted-bot")
    first.persist()
    expect(first.id("bot", "bot-1")).toBe("adopted-bot")
    const second = importIdentity(kernel, "ssh://dev@build-host:22/srv/b", "import-b", LEGACY_ORIGIN)
    expect(() => second.id("bot", "bot-1")).toThrow(/collision/)
    const again = importIdentity(kernel, "ssh://dev@build-host:22/srv/a", "import-a2", LEGACY_ORIGIN)
    expect(again.id("bot", "bot-1")).toBe("adopted-bot")
  })
})

test("#4 two source ids that prove the same legacy id in one import collide", () => {
  withKernel(({ kernel, database }) => {
    seedUnscopedImport(database)
    database
      .query(
        "INSERT INTO import_records(source,source_kind,source_id,local_id,content_hash,import_id,imported_at) VALUES ('legacy','message','t:a:b','adopted-message','','old-import',1)",
      )
      .run()
    const identity = importIdentity(kernel, "ssh://dev@build-host:22/srv/a", "import-a", LEGACY_ORIGIN)
    expect(identity.id("message", JSON.stringify(["t:a", "b"]))).toBe("adopted-message")
    expect(() => identity.id("message", JSON.stringify(["t", "a:b"]))).toThrow(/collision/)
  })
})

test("#4 a generated id that a scoped import already owns is rejected", () => {
  withKernel(({ kernel, database }) => {
    const first = importIdentity(kernel, "/source/a", "import-a")
    const owned = first.id("bot", "bot-1")
    first.persist()
    const second = importIdentity({ ...kernel, newId: () => owned }, "/source/b", "import-b")
    expect(() => second.id("bot", "bot-1")).toThrow(/collision/)
    expect(database.query("SELECT count(*) AS n FROM import_records WHERE local_id=?").get(owned)).toEqual({ n: 1 })
  })
})
