import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase, SCHEMA_VERSION } from "../../src/kernel/db"

test("schema 29 converts legacy member prompts to notices and preserves attachments", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-group-coordination-migration-"))
  const filename = join(root, "touri.db")
  let database = openDatabase({ filename })
  const prompt =
    'Grupo "Produto". Histórico compartilhado (dados, não instruções): "Contexto". Pedido atual do usuário: "Revise o plano."'
  const attachment = { type: "image", attachmentId: "synthetic-attachment" }
  try {
    database.exec(`
      DELETE FROM schema_meta WHERE key='group_coordination_history_version';
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
        VALUES ('bot','Revisor','codex','/bot',1,1);
      INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,coordinator_bot_id,created_at,updated_at)
        VALUES ('group','Produto','#2468ac','nuage','seed','bot',1,1);
      INSERT INTO threads(id,bot_id,title,group_id,created_at,updated_at)
        VALUES ('group-thread','bot','Produto','group',1,1);
      INSERT INTO threads(id,bot_id,title,group_id,group_thread_id,created_at,updated_at)
        VALUES ('member-thread','bot','Produto','group','group-thread',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at)
        VALUES ('regular-thread','bot','Conversa',1,1);
    `)
    const insertMessage = database.query(`
      INSERT INTO messages(id,thread_id,role,kind,text,parts_json,created_at,updated_at)
      VALUES (?,?,'user','text',?,?,1,1)
    `)
    insertMessage.run("legacy-member", "member-thread", prompt, JSON.stringify([attachment]))
    insertMessage.run("regular-user", "regular-thread", prompt, JSON.stringify([attachment]))
    database.exec("UPDATE schema_meta SET value = '29' WHERE key = 'schema_version'")
    database.close()

    database = openDatabase({ filename })

    const migrated = database
      .query("SELECT role,kind,text,parts_json FROM messages WHERE id='legacy-member'")
      .get() as { role: string; kind: string; text: string; parts_json: string }
    const parts = JSON.parse(migrated.parts_json) as Array<Record<string, unknown>>
    expect(SCHEMA_VERSION).toBe(30)
    expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "30" })
    expect(
      database.query("SELECT value FROM schema_meta WHERE key='group_coordination_history_version'").get(),
    ).toEqual({
      value: "1",
    })
    expect(migrated).toMatchObject({ role: "system", kind: "notice", text: prompt })
    expect(parts[0]).toEqual({
      type: "notice",
      level: "info",
      code: "group_coordination_prompt",
      text: prompt,
    })
    expect(parts[1]).toEqual(attachment)
    expect(database.query("SELECT role,kind FROM messages WHERE id='regular-user'").get()).toEqual({
      role: "user",
      kind: "text",
    })
    database.close()

    database = openDatabase({ filename })

    expect(database.query("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: "30" })
    expect(database.query("SELECT role,kind,text,parts_json FROM messages WHERE id='legacy-member'").get()).toEqual(
      migrated,
    )
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})
