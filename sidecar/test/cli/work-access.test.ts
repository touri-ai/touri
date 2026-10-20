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
  CREATE TABLE bot_groups (id TEXT PRIMARY KEY);
  CREATE TABLE group_members (bot_id TEXT NOT NULL, group_id TEXT NOT NULL);
  CREATE TABLE threads (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, group_id TEXT, owner_person_id TEXT, archived_at INTEGER
  );
  CREATE TABLE workspace_message_attention (
    approval_id TEXT, thread_id TEXT NOT NULL, type TEXT NOT NULL, decision TEXT
  );
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
  INSERT INTO bots(id, archived_at, responsible_person_id) VALUES ('legacy-bot', NULL, NULL), ('member-bot', NULL, 'member'),
    ('other-bot', NULL, 'owner'), ('team-bot', NULL, 'owner'), ('deleted-channel-bot', NULL, 'owner');
  INSERT INTO bot_groups VALUES ('team-a'), ('team-b');
  INSERT INTO group_members VALUES ('team-bot', 'team-a'), ('other-bot', 'team-b'),
    ('deleted-channel-bot', 'deleted-channel');
  INSERT INTO threads VALUES ('member-dm', 'member-bot', NULL, 'member', NULL),
    ('other-dm', 'other-bot', NULL, 'owner', NULL), ('team-chat', 'team-bot', 'team-a', NULL, NULL),
    ('other-chat', 'other-bot', 'team-b', NULL, NULL);
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

afterEach(() => database.exec("DELETE FROM group_run_links"))

const access = createWorkAccess({
  database,
  authStore: {
    getPersonChannelIds: (personId) => (personId === "member" ? ["team-a", "deleted-channel"] : []),
    getPerson: (personId) =>
      personId === "owner"
        ? ({ id: "owner", role: "admin" } as ReturnType<AuthStore["getPerson"]>)
        : personId === "member"
          ? ({ id: "member", role: "member" } as ReturnType<AuthStore["getPerson"]>)
          : null,
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

test("members cannot create channels or bots, invite people, or open another person's private chat", () => {
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

test("channel membership cannot open a private session with another person's bot", () => {
  const request = { personId: "member", role: "member" as const, method: "POST", pathname: "/threads" }

  expect(access.authorizeHttp({ ...request, body: { botId: "team-bot" } })).toMatchObject({ status: 403 })
  expect(access.authorizeHttp({ ...request, body: { botId: "member-bot" } })).toBeNull()
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
