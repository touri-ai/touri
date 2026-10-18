import type { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createKernel } from "../../src/kernel"
import { summarizeToolResolutions } from "../../src/runtime/tool-resolution-summary"
import { init as initStore } from "../../src/store"

const fixtures = new Set<Awaited<ReturnType<typeof getFixture>>>()

afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

test("bounded paths preserve order, branch membership and an explicit leaf", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { store } = fixture
  const getIds = (options: Parameters<typeof store.activePath>[0]) =>
    store.activePath(options).map((message) => message.id)

  expect(getIds({ threadId: "thread", limit: 2 })).toEqual(["request-a", "reply-a"])
  expect(getIds({ threadId: "thread", limit: 1, fromRoot: true })).toEqual(["root"])
  expect(getIds({ threadId: "thread", limit: 0, fromRoot: true })).toEqual([])
  expect(getIds({ threadId: "thread", leafId: "reply-b" })).toEqual(["root", "request-b", "reply-b"])
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "root" })?.id).toBe("root")
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "request-b" })).toBeNull()
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "reply-b", leafId: "reply-b" })?.id).toBe("reply-b")
})

test("cyclic and missing parents terminate without repeating messages", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store } = fixture
  database.exec("UPDATE messages SET parent_id = 'reply-a' WHERE id = 'root'")

  expect(store.activePath({ threadId: "thread" }).map((message) => message.id)).toEqual([
    "root",
    "request-a",
    "reply-a",
  ])
  expect(store.getPathMessage?.({ threadId: "thread", messageId: "absent" })).toBeNull()
  database.exec("UPDATE messages SET parent_id = 'missing' WHERE id = 'root'")
  expect(store.activePath({ threadId: "thread" })).toHaveLength(3)
})

test("reconciliation selects the latest thirty tools on the requested branch without hydrating history", async () => {
  const fixture = await getFixture()
  fixtures.add(fixture)
  const { database, store } = fixture
  database.transaction(() => {
    Array.from({ length: 80 }, (_, index) => index).forEach((index) => {
      const callId = `call-${String(index).padStart(3, "0")}`
      const part = {
        type: "tool_call",
        callId,
        tool: "fixture_tool",
        inputJson: "{}",
        outputJson: "resultado",
        ok: true,
      }
      database
        .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution)
        VALUES ('run-a',?,'thread',?,'completed_unobserved')`)
        .run(callId, JSON.stringify(part))
    })
    database
      .query(`INSERT INTO tool_resolutions(run_id,call_id,thread_id,part_json,resolution)
      VALUES ('run-b','other-branch','thread',?,'completed_unobserved')`)
      .run(
        JSON.stringify({
          type: "tool_call",
          callId: "other-branch",
          tool: "other_tool",
          inputJson: "{}",
          outputJson: "outro",
          ok: true,
        }),
      )
  })()
  const path = getPathSpy(store)
  fixture.restore.add(path.restore)

  const summary = summarizeToolResolutions(database, store, "thread", "reply-a")

  expect(path.getCalls()).toBe(0)
  expect(summary).toContain("call-050")
  expect(summary).toContain("call-079")
  expect(summary).not.toContain("call-049")
  expect(summary).not.toContain("other-branch")
  expect(summary).toContain("history_read")
  expect(summary?.match(/fixture_tool/g)).toHaveLength(30)
})

const getPathSpy = (store: Awaited<ReturnType<typeof getFixture>>["store"]) => {
  const path = spyOn(store, "activePath")
  return { getCalls: () => path.mock.calls.length, restore: () => path.mockRestore() }
}

const getOfflineRuntime = (root: string) => {
  const serve = spyOn(Bun, "serve").mockReturnValue({ port: 0, stop: () => {} } as ReturnType<typeof Bun.serve>)
  try {
    return createKernel({ appData: root })
  } finally {
    serve.mockRestore()
  }
}

const getFixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-message-history-"))
  const runtime = getOfflineRuntime(root)
  runtime.kernel.services.use("storage.maintenance")?.dispose()
  await initStore(runtime.kernel)
  const database = runtime.kernel.db as Database
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('bot','Teste','codex','/tmp/fixture',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Conversa',1,1);
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,request_message_id,queued_at) VALUES
      ('run-a','thread','bot','codex','user','succeeded','request-a',1),
      ('run-b','thread','bot','codex','user','succeeded','request-b',2);
    INSERT INTO messages(id,thread_id,parent_id,role,kind,status,run_id,text,created_at,updated_at) VALUES
      ('root','thread',NULL,'user','text','complete',NULL,'Raiz',1,1),
      ('request-a','thread','root','user','text','complete',NULL,'A',2,2),
      ('reply-a','thread','request-a','assistant','text','complete','run-a','Resposta A',3,3),
      ('request-b','thread','root','user','text','complete',NULL,'B',4,4),
      ('reply-b','thread','request-b','assistant','text','complete','run-b','Resposta B',5,5);
    UPDATE threads SET active_leaf_id = 'reply-a' WHERE id = 'thread';`)
  const store = runtime.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const restore = new Set<() => void>()

  return {
    database,
    store,
    restore,
    close: () => {
      restore.forEach((callback) => {
        callback()
      })
      runtime.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
