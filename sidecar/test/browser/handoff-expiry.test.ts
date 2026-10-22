import { afterEach, expect, test } from "bun:test"
import type { Message, MessagePart } from "@touri/contracts"
import { reportBrowserHandoffExpiry } from "../../src/browser/handoff-expiry"
import { init as initStore } from "../../src/store"
import { testKernel } from "../kernel/test-kernel"

const fixtures = new Set<ReturnType<typeof testKernel>>()
afterEach(() => {
  fixtures.forEach((fixture) => {
    fixture.close()
  })
  fixtures.clear()
})

test("expiry is persisted in the original reply and shared channel without changing the assistant's words", async () => {
  const fixture = testKernel()
  fixtures.add(fixture)
  await initStore(fixture.kernel)
  fixture.db.exec(`
    INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('leo','Léo','codex','/workspace',1,1);
    INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at) VALUES ('travel','Viagens','#888888','circle','travel',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at,group_id,group_thread_id)
      VALUES ('channel','leo','Viagens',1,1,'travel',NULL), ('child','leo','Viagens',1,1,'travel','channel');
    INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,reply_message_id)
      VALUES ('run','child','leo','codex','user','succeeded',1,'reply');
  `)
  const store = fixture.kernel.services.use("store.api")
  if (!store) throw new Error("Missing store")
  const parts: MessagePart[] = [{ type: "text", text: "Aguardando você entrar no site." }]
  const getMessage = (id: string, threadId: string): Omit<Message, "createdAt" | "updatedAt"> => ({
    id,
    threadId,
    runId: "run",
    parentId: null,
    role: "assistant",
    kind: "text",
    status: "complete",
    text: "Aguardando você entrar no site.",
    parts,
    sender: { id: "leo", name: "Léo" },
    source: "local",
  })
  expect(store.insertMessage({ message: getMessage("reply", "child") }).success).toBe(true)
  expect(store.insertMessage({ message: getMessage("shared", "channel") }).success).toBe(true)
  fixture.db.exec(
    "INSERT INTO group_message_links(source_thread_id,message_id,visible_message_id) VALUES ('child','reply','shared')",
  )

  reportBrowserHandoffExpiry({ kernel: fixture.kernel, runId: "run", originalRunId: "run" })
  reportBrowserHandoffExpiry({ kernel: fixture.kernel, runId: "run", originalRunId: "run" })

  for (const threadId of ["child", "channel"]) {
    const saved = store.activePath({ threadId })[0]
    expect(saved?.text).toBe("Aguardando você entrar no site.")
    expect(saved?.parts).toEqual(
      parts.concat({
        type: "notice",
        level: "warning",
        code: "run_failed",
        text: "No one took over in time. Ask again when you can.",
      }),
    )
  }
})
