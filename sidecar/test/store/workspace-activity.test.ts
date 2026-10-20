import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"
import { readWorkspaceActivity } from "../../src/store/workspace-activity"

test("workspace activity keeps previews, old approvals and active runs without history or tool output", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-workspace-"))
  const db = openDatabase({ filename: join(root, "test.db") })
  try {
    db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Bot','codex','/tmp/bot',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('public','bot','Chat',1,1), ('private','bot','Private',1,1), ('archived','bot','Archive',1,1);
      UPDATE threads SET group_thread_id = 'public' WHERE id = 'private';
      UPDATE threads SET archived_at = 1 WHERE id = 'archived';`)
    const insert = db.query(
      "INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at) VALUES (?,?,'assistant','text','complete',?,?,?,?)",
    )
    const approval = [
      { type: "approval", approvalId: "approval", request: "command", detail: "pwd", decision: "pending" },
    ]
    insert.run("approval", "public", "Approve command", JSON.stringify(approval), 1, 1)
    for (let index = 2; index < 42; index++) insert.run(`old-${index}`, "public", "Old history", "[]", index, index)
    insert.run(
      "latest",
      "public",
      "Latest reply ".repeat(1000),
      JSON.stringify([{ type: "tool_call", outputJson: "Tool output ".repeat(1000) }]),
      42,
      42,
    )
    for (const id of ["private", "archived"]) insert.run(id, id, "Hidden", JSON.stringify(approval), 1, 1)
    db.exec(`INSERT INTO runs(id,thread_id,bot_id,provider,trigger,status,queued_at,started_at) VALUES
      ('active','public','bot','codex','user','running',1,2),
      ('finished','public','bot','codex','user','succeeded',3,3),
      ('private-run','private','bot','codex','user','running',1,2);`)
    const activity = readWorkspaceActivity(db)
    expect(activity.messages.map((message) => message.id).sort()).toEqual(["approval", "latest"])
    const latest = activity.messages.find((message) => message.id === "latest")
    expect(latest?.text).toHaveLength(512)
    expect(JSON.parse(latest?.parts_json ?? "null")).toEqual([])
    expect(JSON.parse(activity.messages.find((message) => message.id === "approval")?.parts_json ?? "null")).toEqual(
      approval,
    )
    expect(activity.runs.map((run) => run.id).sort()).toEqual(["active", "finished"])
    expect(JSON.stringify(activity).length).toBeLessThan(4000)
    expect(
      (db.query("SELECT text FROM messages WHERE id = 'latest'").get() as { text: string }).text.length,
    ).toBeGreaterThan(512)
    db.query("UPDATE messages SET parts_json = ? WHERE id = 'approval'").run(
      JSON.stringify([{ ...approval[0], decision: "approved" }]),
    )
    db.exec(
      "INSERT INTO notifications(kind,level,thread_id,title,body,request_id,created_at) VALUES ('approval','warning','public','Approve','Command','approval',1)",
    )
    expect(readWorkspaceActivity(db).messages.some((message) => message.id === "approval")).toBe(true)
    db.exec("UPDATE notifications SET resolved_at = 42")
    expect(readWorkspaceActivity(db).messages.some((message) => message.id === "approval")).toBe(false)
    db.exec(`INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at) VALUES ('group','Team','#888888','cercle','team',1,1);
      INSERT INTO group_turns(run_id,group_id,recipients_json) VALUES ('active','group','[]');
      INSERT INTO group_run_links(run_id,turn_id,depth) VALUES ('private-run','active',1);`)
    expect(readWorkspaceActivity(db).runs.find((run) => run.id === "private-run")?.threadId).toBe("public")
    insert.run("late-failure", "public", "Interrupted", "[]", 0, 100)
    insert.run("stream", "public", "", "[]", 99, 99)
    db.exec(
      "UPDATE messages SET status = 'failed' WHERE id = 'late-failure'; UPDATE messages SET status = 'streaming' WHERE id = 'stream'",
    )
    expect(readWorkspaceActivity(db).messages.some((message) => message.id === "late-failure")).toBe(true)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("workspace activity scopes private conversations to their person and channels to membership", () => {
  const root = mkdtempSync(join(tmpdir(), "touri-workspace-scope-"))
  const db = openDatabase({ filename: join(root, "test.db") })
  try {
    db.exec(`
      INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at) VALUES ('bot','Bot','codex','/tmp/bot',1,1);
      INSERT INTO bot_groups(id,name,color,avatar_shape,avatar_seed,created_at,updated_at)
        VALUES ('team-a','Team A','#888888','circle','a',1,1), ('team-b','Team B','#888888','circle','b',1,1);
      INSERT INTO threads(id,bot_id,title,created_at,updated_at,owner_person_id,group_id)
        VALUES ('member-dm','bot','Own chat',1,1,'member',NULL),
          ('other-dm','bot','Other chat',1,1,'owner',NULL),
          ('member-channel','bot','Member channel',1,1,NULL,'team-a'),
          ('other-channel','bot','Other channel',1,1,NULL,'team-b');
    `)
    const insert = db.query(
      "INSERT INTO messages(id,thread_id,role,kind,status,text,parts_json,created_at,updated_at) VALUES (?,?,'user','text','complete',?,'[]',1,1)",
    )
    insert.run("own-message", "member-dm", "Own")
    insert.run("other-message", "other-dm", "Private")
    insert.run("member-channel-message", "member-channel", "Team")
    insert.run("other-channel-message", "other-channel", "Secret")
    const activity = readWorkspaceActivity(db, { personId: "member", channelIds: ["team-a"] })
    expect(activity.messages.map((message) => message.id).sort()).toEqual(["member-channel-message", "own-message"])
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
