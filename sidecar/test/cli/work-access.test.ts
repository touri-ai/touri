import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import type { UiEvent } from "@touri/contracts"
import type { AuthStore } from "../../src/cli/auth/store"
import { createWorkAccess } from "../../src/cli/work-access"

const database = new Database(":memory:")
database.exec(`
  CREATE TABLE bots (
    id TEXT PRIMARY KEY, archived_at INTEGER, responsible_person_id TEXT, sort_order INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0
  );
  CREATE TABLE bot_deletions (bot_id TEXT PRIMARY KEY, phase TEXT NOT NULL);
  CREATE TABLE bot_groups (id TEXT PRIMARY KEY);
  CREATE TABLE group_members (bot_id TEXT NOT NULL, group_id TEXT NOT NULL);
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, group_id TEXT, owner_person_id TEXT, archived_at INTEGER,
    group_thread_id TEXT
  );
  CREATE TABLE workspace_message_attention (
    approval_id TEXT, thread_id TEXT NOT NULL, type TEXT NOT NULL, decision TEXT
  );
  CREATE TABLE workspace_attention_backfill (id INTEGER PRIMARY KEY);
  CREATE TABLE notifications (kind TEXT NOT NULL, thread_id TEXT, request_id TEXT, resolved_at INTEGER);
  CREATE TABLE runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, request_message_id TEXT);
  CREATE TABLE messages (
    thread_id TEXT NOT NULL, id TEXT NOT NULL, sender_json TEXT, parts_json TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY(thread_id,id)
  );
  CREATE TABLE attachments (id TEXT PRIMARY KEY, owner_person_id TEXT);
  CREATE TABLE attachment_people (attachment_id TEXT NOT NULL, person_id TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY(attachment_id,person_id));
  CREATE TABLE attachment_message_refs (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
    PRIMARY KEY(thread_id,message_id,attachment_id)
  );
  CREATE TABLE group_run_links (run_id TEXT NOT NULL, turn_id TEXT NOT NULL);
  CREATE TABLE browser_channel_runs (
    run_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, thread_id TEXT NOT NULL, bot_id TEXT NOT NULL,
    requester_person_id TEXT, responsible_person_id TEXT, controller_person_id TEXT, status TEXT NOT NULL,
    queued_at INTEGER DEFAULT 1, active_run_id TEXT
  );
  CREATE TABLE browser_tabs (id TEXT PRIMARY KEY, owner_bot_id TEXT, owner_thread_id TEXT);
  INSERT INTO bots(id, archived_at, responsible_person_id) VALUES ('legacy-bot', NULL, NULL), ('member-bot', NULL, 'member'),
    ('other-bot', NULL, 'owner'), ('team-bot', NULL, 'owner'), ('deleted-channel-bot', NULL, 'owner');
  INSERT INTO browser_tabs(id, owner_bot_id) VALUES
    ('member-tab', 'member-bot'), ('team-tab', 'team-bot'), ('other-tab', 'other-bot');
  INSERT INTO bot_groups VALUES ('team-a'), ('team-b');
  INSERT INTO group_members VALUES ('team-bot', 'team-a'), ('other-bot', 'team-b'),
    ('deleted-channel-bot', 'deleted-channel');
  INSERT INTO threads VALUES ('member-dm', 'member-bot', NULL, 'member', NULL, NULL),
    ('other-dm', 'other-bot', NULL, 'owner', NULL, NULL), ('team-chat', 'team-bot', 'team-a', NULL, NULL, NULL),
    ('other-chat', 'other-bot', 'team-b', NULL, NULL, NULL),
    ('team-bot-session', 'team-bot', 'team-a', NULL, NULL, 'team-chat');
  INSERT INTO threads VALUES ('team-private','team-bot',NULL,'owner',NULL,NULL);
  INSERT INTO browser_tabs VALUES ('channel-tab','team-bot','team-chat'), ('private-tab','team-bot','team-private');
  INSERT INTO workspace_message_attention VALUES ('member-approval', 'member-dm', 'approval', 'pending'),
    ('other-approval', 'other-dm', 'approval', 'pending'), ('team-approval', 'team-chat', 'approval', 'pending');
  INSERT INTO runs VALUES ('member-run', 'member-dm', 'member-request'), ('other-run', 'other-dm', 'owner-request');
  INSERT INTO messages VALUES ('member-dm', 'member-request', '{"id":"member"}', '[{"attachmentId":"member-file"}]'),
    ('other-dm', 'owner-request', '{"id":"owner"}', '[{"attachmentId":"private-file"}]'),
    ('team-chat', 'channel-message', NULL, '[{"attachmentId":"channel-file"}]');
  INSERT INTO attachments VALUES ('unattached-member-file', 'member'), ('unattached-private-file', 'owner');
  INSERT INTO attachment_message_refs VALUES ('member-dm', 'member-request', 'member-file'),
    ('other-dm', 'owner-request', 'private-file'), ('team-chat', 'channel-message', 'channel-file');
`)

afterEach(() => {
  database.exec("DELETE FROM group_run_links; DELETE FROM notifications; DELETE FROM workspace_attention_backfill")
  database.query("DELETE FROM threads WHERE id = 'member-channel-thread'").run()
  database.query("UPDATE threads SET archived_at = NULL WHERE id = 'member-dm'").run()
})

const access = createWorkAccess({
  database,
  authStore: {
    getPersonChannelIds: (personId) =>
      personId === "member" || personId === "second-member" ? ["team-a", "deleted-channel"] : [],
    getPerson: (personId) => {
      if (personId === "owner")
        return { id: "owner", name: "Carla", role: "admin" } as ReturnType<AuthStore["getPerson"]>
      if (personId === "member" || personId === "second-member")
        return { id: personId, name: "Ana", role: "member" } as ReturnType<AuthStore["getPerson"]>
      return null
    },
  } as AuthStore,
})

test("members can only see their channels, their own conversations, and bots available to them", () => {
  expect(access.canAccessGroup({ personId: "member", role: "member", groupId: "team-a" })).toBe(true)
  expect(access.canAccessGroup({ personId: "member", role: "member", groupId: "team-b" })).toBe(false)
  expect(access.canAccessBot({ personId: "member", role: "member", botId: "member-bot" })).toBe(true)
  expect(access.canAccessBot({ personId: "member", role: "member", botId: "team-bot" })).toBe(true)
  expect(access.canAccessBot({ personId: "member", role: "member", botId: "other-bot" })).toBe(false)
  expect(access.canAccessBot({ personId: "member", role: "member", botId: "deleted-channel-bot" })).toBe(false)
  expect(access.canAccessBot({ personId: "owner", role: "member", botId: "legacy-bot" })).toBe(true)
  expect(access.canAccessBot({ personId: "owner", role: "admin", botId: "other-bot" })).toBe(true)
  expect(new Set(access.accessibleBotIds({ personId: "member", channelIds: ["team-a"] }))).toEqual(
    new Set(["member-bot", "team-bot"]),
  )
  expect(access.canAccessThread({ personId: "member", role: "member", threadId: "member-dm" })).toBe(true)
  expect(access.canAccessThread({ personId: "member", role: "member", threadId: "other-dm" })).toBe(false)
  expect(access.canAccessThread({ personId: "member", role: "member", threadId: "team-chat" })).toBe(true)
  expect(access.canAccessThread({ personId: "member", role: "member", threadId: "other-chat" })).toBe(false)
})

test("members stop seeing bots as soon as deletion is marked", () => {
  database.query("INSERT INTO bot_deletions(bot_id, phase) VALUES ('member-bot', 'stopping')").run()

  expect(access.accessibleBotIds({ personId: "member", channelIds: ["team-a"] })).not.toContain("member-bot")
})

test("members cannot create channels or bots, delete bots, invite people, or open another person's private chat", () => {
  expect(
    access.authorizeHttp({ personId: "member", role: "member", method: "POST", pathname: "/groups", body: {} }),
  ).toMatchObject({
    status: 403,
  })
  expect(
    access.authorizeHttp({ personId: "member", role: "member", method: "POST", pathname: "/bots", body: {} }),
  ).toMatchObject({
    status: 403,
  })
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "DELETE",
      pathname: "/bots/member-bot",
      body: { name: "Member bot" },
    }),
  ).toMatchObject({ status: 403 })
  expect(
    access.authorizeHttp({ personId: "member", role: "member", method: "POST", pathname: "/invites", body: {} }),
  ).toMatchObject({
    status: 403,
  })
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/threads",
      body: { botId: "other-bot" },
    }),
  ).toMatchObject({ status: 403 })
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "GET",
      pathname: "/threads/other-dm/messages",
      body: null,
    }),
  ).toMatchObject({ status: 404 })
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "PATCH",
      pathname: "/bots/other-bot",
      body: {},
    }),
  ).toMatchObject({ status: 403 })
})

test("thread deletion routes allow admins and thread owners but deny other channel members", () => {
  database
    .query(
      "INSERT INTO threads(id,bot_id,group_id,owner_person_id,archived_at) VALUES ('member-channel-thread','team-bot','team-a','member',NULL)",
    )
    .run()
  const authorize = (method: string, pathname: string, body: unknown = null) =>
    access.authorizeHttp({ personId: "member", role: "member", method, pathname, body })

  expect(authorize("GET", "/threads/member-dm/delete-preview")).toBeNull()
  expect(authorize("DELETE", "/threads/member-dm")).toBeNull()
  expect(authorize("DELETE", "/threads/member-channel-thread")).toBeNull()
  expect(authorize("GET", "/threads/team-chat/delete-preview")).toMatchObject({ status: 403 })
  expect(authorize("DELETE", "/threads/team-chat")).toMatchObject({ status: 403 })
  expect(authorize("DELETE", "/threads/other-dm")).toMatchObject({ status: 403 })
  expect(authorize("POST", "/threads/delete", { ids: ["member-dm", "team-chat"] })).toMatchObject({ status: 403 })
  expect(authorize("POST", "/threads/delete", { ids: ["member-dm", "member-channel-thread"] })).toBeNull()
  expect(
    access.authorizeHttp({
      personId: "owner",
      role: "admin",
      method: "DELETE",
      pathname: "/threads/team-chat",
      body: null,
    }),
  ).toBeNull()
})

test("thread owners can open and restore archived conversations", () => {
  database.query("UPDATE threads SET archived_at = 1 WHERE id = 'member-dm'").run()

  expect(access.canAccessThread({ personId: "member", role: "member", threadId: "member-dm" })).toBe(true)
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "PATCH",
      pathname: "/threads/member-dm",
      body: { archived: false },
    }),
  ).toBeNull()
})

test("deleted thread events only reach the owner, bot owner, admins or channel members", () => {
  const groupEvent: UiEvent = {
    type: "thread.deleted",
    threadId: "team-chat",
    botId: "team-bot",
    groupId: "team-a",
    ownerPersonId: null,
    responsiblePersonId: "owner",
  }
  const privateEvent: UiEvent = {
    type: "thread.deleted",
    threadId: "other-dm",
    botId: "other-bot",
    groupId: null,
    ownerPersonId: "owner",
    responsiblePersonId: "owner",
  }

  expect(access.visibleEvent({ personId: "member", role: "member", event: groupEvent })).toBe(true)
  expect(access.visibleEvent({ personId: "member", role: "member", event: privateEvent })).toBe(false)
  expect(access.visibleEvent({ personId: "owner", role: "member", event: privateEvent })).toBe(true)
})

test("channel membership cannot open a private session with another person's bot", () => {
  const request = { personId: "member", role: "member" as const, method: "POST", pathname: "/threads" }

  expect(access.authorizeHttp({ ...request, body: { botId: "team-bot" } })).toMatchObject({ status: 403 })
  expect(access.authorizeHttp({ ...request, body: { botId: "member-bot" } })).toBeNull()
})

test("browser visibility filters requests before the handler checks legacy control permissions", () => {
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "GET",
      pathname: "/bots/team-bot/browser-preview",
      body: null,
    }),
  ).toBeNull()
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/browser/tabs/team-tab/takeover/session",
      body: null,
    }),
  ).toBeNull()
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/browser/tabs/member-tab/takeover/session",
      body: null,
    }),
  ).toBeNull()
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/browser/tabs/other-tab/takeover/input",
      body: null,
    }),
  ).toMatchObject({ status: 404 })
})

test("members get event sockets and presence only for bots in their channels", () => {
  expect(access.authorizeSocket({ personId: "member", role: "member", path: "/api/v1/events" })).toBe(true)
  expect(
    access.authorizeSocket({
      personId: "member",
      role: "member",
      path: "/api/v1/bots/team-bot/machine/presence/socket",
    }),
  ).toBe(true)
  expect(
    access.authorizeSocket({
      personId: "member",
      role: "member",
      path: "/api/v1/bots/other-bot/machine/presence/socket",
    }),
  ).toBe(false)
  expect(access.authorizeSocket({ personId: "member", role: "member", path: "/api/v1/desktop/abc/socket" })).toBe(false)
  expect(
    access.authorizeHttp({ personId: "member", role: "member", method: "POST", pathname: "/ws-ticket", body: null }),
  ).toBeNull()
})

test("only a bot's responsible person can approve its pending request", () => {
  expect(access.canApprove({ personId: "member", approvalId: "member-approval" })).toBe(true)
  expect(access.canApprove({ personId: "member", approvalId: "other-approval" })).toBe(false)
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/approvals/other-approval",
      body: { decision: "approved" },
    }),
  ).toMatchObject({ status: 403 })
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/approvals/member-approval",
      body: { decision: "approved" },
    }),
  ).toBeNull()
  expect(
    access.canAccessNotification({
      personId: "member",
      role: "member",
      threadId: "other-dm",
      kind: "approval",
      requestId: "other-approval",
    }),
  ).toBe(false)
  expect(
    access.visibleEvent({
      personId: "member",
      role: "member",
      event: { type: "message.created", message: { threadId: "other-dm" } } as UiEvent,
    }),
  ).toBe(false)
  expect(
    access.visibleEvent({
      personId: "member",
      role: "member",
      event: {
        type: "notification.created",
        notification: { threadId: "team-chat", kind: "approval", requestId: "team-approval" },
      } as UiEvent,
    }),
  ).toBe(false)
  expect(
    access.visibleEvent({
      personId: "member",
      role: "member",
      event: { type: "notify", threadId: "team-chat", kind: "approval", requestId: "team-approval" } as UiEvent,
    }),
  ).toBe(false)
})

test("pending approval notifications remain available while the workspace projection catches up", () => {
  database.exec("INSERT INTO workspace_attention_backfill(id) VALUES (1)")
  database
    .query(
      "INSERT INTO notifications(kind, thread_id, request_id) VALUES ('approval', 'member-dm', 'catchup-approval')",
    )
    .run()

  expect(access.canApprove({ personId: "member", approvalId: "catchup-approval" })).toBe(true)
  expect(access.canApprove({ personId: "owner", approvalId: "catchup-approval" })).toBe(false)

  database.query("UPDATE notifications SET resolved_at = 1 WHERE request_id = 'catchup-approval'").run()

  expect(access.canApprove({ personId: "member", approvalId: "catchup-approval" })).toBe(false)
})

test("members cannot inspect or stop another person's runs", () => {
  expect(access.canAccessRun({ personId: "member", role: "member", runId: "member-run" })).toBe(true)
  expect(access.canAccessRun({ personId: "member", role: "member", runId: "other-run" })).toBe(false)
  expect(
    access.accessibleRunIds({ personId: "member", channelIds: ["team-a"], runIds: ["member-run", "other-run"] }),
  ).toEqual(["member-run"])
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "POST",
      pathname: "/runs/other-run/cancel",
      body: null,
    }),
  ).toMatchObject({ status: 404 })
  expect(access.personForRun("member-run")).toBeNull()
  expect(access.isAdminRun("member-run")).toBe(false)
  expect(access.personForRun("other-run")).toBe("owner")
  expect(access.isAdminRun("other-run")).toBe(true)
})

test("only the requester and the responsible person can stop or take over a channel browser run", () => {
  database.query(`INSERT INTO runs VALUES ('channel-browser-run', 'team-bot-session', 'request')`).run()
  database
    .query(`INSERT INTO browser_channel_runs(run_id,group_id,thread_id,bot_id,requester_person_id,responsible_person_id,controller_person_id,status,queued_at) VALUES
      ('channel-browser-run', 'team-a', 'team-chat', 'team-bot', 'member', 'owner', 'owner', 'taken_over', 1)`)
    .run()
  database.query("INSERT OR REPLACE INTO browser_tabs VALUES ('channel-tab', 'team-bot', 'team-bot-session')").run()

  const cancel = {
    role: "member" as const,
    method: "POST",
    pathname: "/runs/channel-browser-run/cancel",
    body: null,
  }
  expect(access.authorizeHttp({ ...cancel, personId: "member" })).toBeNull()
  expect(access.authorizeHttp({ ...cancel, personId: "owner", role: "admin" })).toBeNull()
  expect(access.authorizeHttp({ ...cancel, personId: "other", role: "member" })).toMatchObject({ status: 404 })
  const deniedCancel = access.authorizeHttp({ ...cancel, personId: "second-member", role: "member" })
  expect(deniedCancel).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
  expect(deniedCancel?.json.error).toContain("Carla está no controle")

  const takeover = {
    role: "member" as const,
    method: "POST",
    pathname: "/browser/tabs/channel-tab/takeover",
    body: { hold: true },
  }
  expect(access.authorizeHttp({ ...takeover, personId: "member" })).toBeNull()
  expect(access.authorizeHttp({ ...takeover, personId: "owner", role: "admin" })).toBeNull()
  expect(access.authorizeHttp({ ...takeover, personId: "other", role: "member" })).toMatchObject({ status: 404 })
  const deniedTakeover = access.authorizeHttp({ ...takeover, personId: "second-member", role: "member" })
  expect(deniedTakeover).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
  expect(deniedTakeover?.json.error).toContain("Carla está no controle")

  expect(
    access.authorizeHttp({
      role: "member",
      method: "POST",
      pathname: "/browser/tabs/channel-tab/takeover/session",
      personId: "member",
      body: null,
    }),
  ).toBeNull()
  expect(
    access.authorizeHttp({
      role: "admin",
      method: "POST",
      pathname: "/browser/tabs/channel-tab/takeover/session",
      personId: "owner",
      body: null,
    }),
  ).toBeNull()
  expect(
    access.authorizeHttp({
      role: "member",
      method: "POST",
      pathname: "/browser/tabs/channel-tab/takeover/session",
      personId: "second-member",
      body: { sessionId: "untrusted" },
    }),
  ).toMatchObject({ status: 403, json: { errorCode: "BROWSER_CONTROL_FORBIDDEN" } })
  expect(
    access.authorizeHttp({
      role: "member",
      method: "POST",
      pathname: "/browser/tabs/channel-tab/takeover/frame",
      personId: "member",
      body: { sessionId: "session-secret" },
    }),
  ).toBeNull()
})

test("targeted needs-you events and notifications are private to their recipient", () => {
  expect(
    access.canAccessNotification({
      personId: "member",
      role: "member",
      threadId: "team-chat",
      kind: "takeover",
      requestId: "browser-needs-you",
      targetPersonId: "member",
    }),
  ).toBe(true)
  expect(
    access.canAccessNotification({
      personId: "second-member",
      role: "member",
      threadId: "team-chat",
      kind: "takeover",
      requestId: "browser-needs-you",
      targetPersonId: "member",
    }),
  ).toBe(false)
  expect(
    access.visibleEvent({
      personId: "owner",
      role: "admin",
      event: {
        type: "notify",
        level: "warning",
        title: "O navegador precisa de você",
        body: "",
        threadId: "team-chat",
        targetPersonId: "member",
      },
    }),
  ).toBe(false)
})

test("members can fetch files from their own chats and channels only", () => {
  expect(access.canAccessAttachment({ personId: "member", role: "member", attachmentId: "member-file" })).toBe(true)
  expect(access.canAccessAttachment({ personId: "member", role: "member", attachmentId: "channel-file" })).toBe(true)
  expect(
    access.canAccessAttachment({ personId: "member", role: "member", attachmentId: "unattached-member-file" }),
  ).toBe(true)
  expect(access.canAccessAttachment({ personId: "member", role: "member", attachmentId: "private-file" })).toBe(false)
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "GET",
      pathname: "/attachments/private-file/content",
      body: null,
    }),
  ).toMatchObject({ status: 404 })
  expect(
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "GET",
      pathname: "/attachments/channel-file",
      body: null,
    }),
  ).toBeNull()
  expect(
    access.authorizeHttp({ personId: "member", role: "member", method: "POST", pathname: "/attachments", body: null }),
  ).toBeNull()
  expect(access.canAccessAttachments({ personId: "member", role: "member", attachmentIds: ["channel-file"] })).toBe(
    true,
  )
  expect(
    access.canAccessAttachments({
      personId: "member",
      role: "member",
      attachmentIds: ["channel-file", "private-file"],
    }),
  ).toBe(false)
  expect(
    access.canAccessAttachments({
      personId: "member",
      role: "member",
      attachmentIds: Array.from({ length: 51 }, (_, index) => `file-${index}`),
    }),
  ).toBe(false)
})

test("browser control reaches requester authorization and rejects malformed requests", () => {
  const request = {
    personId: "member",
    role: "member" as const,
    method: "POST",
    pathname: "/browser/tabs/channel-tab/takeover",
    body: { hold: false },
  }

  const handback = access.authorizeHttp(request)
  const takeover = access.authorizeHttp({ ...request, body: { hold: true } })
  const malformed = access.authorizeHttp({ ...request, body: {} })

  expect(handback).toBeNull()
  expect(takeover).toBeNull()
  expect(malformed?.status).toBe(403)
})

test("channel browser visibility includes shared tabs and excludes the same bot's private tabs", () => {
  const viewer = { personId: "member", role: "member" as const }

  const channel = access.canAccessBrowserTab({ ...viewer, tabId: "channel-tab" })
  const privateTab = access.canAccessBrowserTab({ ...viewer, tabId: "private-tab" })
  const own = access.canAccessBrowserTab({ ...viewer, tabId: "member-tab" })

  expect(channel).toBe(true)
  expect(privateTab).toBe(false)
  expect(own).toBe(true)
  expect(access.canAccessBrowserTab({ personId: "owner", role: "member", tabId: "private-tab" })).toBe(true)
  expect(access.canAccessBrowserTab({ ...viewer, tabId: "missing" })).toBe(false)
})

test("channel browser events use tab scope rather than shared bot membership", () => {
  const viewer = { personId: "member", role: "member" as const }
  const tab = {
    tabId: "channel-tab",
    ownerBotId: "team-bot",
    url: "https://portal.example.test/login",
    title: "Portal",
    state: "live" as const,
    openerTabId: null,
    heldByUser: false,
    lastUsedAt: 1,
  }

  const shared = access.visibleEvent({ ...viewer, event: { type: "browser.tab", tab } })
  const privateEvent = access.visibleEvent({
    ...viewer,
    event: { type: "browser.tab", tab: { ...tab, tabId: "private-tab" } },
  })

  expect(shared).toBe(true)
  expect(privateEvent).toBe(false)
})

test("former channel members cannot delete a conversation even when they created it", () => {
  database
    .query(
      "INSERT INTO threads(id,bot_id,group_id,owner_person_id,archived_at) VALUES ('member-channel-thread','other-bot','team-b','member',NULL)",
    )
    .run()

  const response = access.authorizeHttp({
    personId: "member",
    role: "member",
    method: "DELETE",
    pathname: "/threads/member-channel-thread",
    body: null,
  })

  expect(response).toMatchObject({ status: 403 })
})

test("a member can request previews for a channel bot but not an unrelated bot", () => {
  const preview = (botId: string) =>
    access.authorizeHttp({
      personId: "member",
      role: "member",
      method: "GET",
      pathname: `/bots/${botId}/browser-preview`,
      body: null,
    })

  expect(preview("team-bot")).toBeNull()
  expect(preview("other-bot")).toMatchObject({ status: 404 })
})
