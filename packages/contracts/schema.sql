-- touri desktop local database, contract v0.
-- File: ~/Library/Application Support/touri/touri.db
-- Engine: SQLite 3.45+ (bun:sqlite). Opened with:
--   PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
-- Conventions:
--   * ids are TEXT. Locally created rows use ULIDs. Imported rows keep the source id
--     (legacy app uses UUIDs), so a re-import hits the same primary key.
--   * timestamps are INTEGER milliseconds since epoch (UTC).
--   * *_json columns hold JSON validated by the types in types.ts.
--   * This is a contract snapshot through schema_version 6; runtime migrations are incremental.

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1');

-- A project is a real folder on disk (usually a git repo) that bots work in.
CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  path           TEXT NOT NULL UNIQUE,          -- absolute path, realpath-resolved
  git_remote     TEXT,                          -- origin URL, credentials stripped
  default_branch TEXT,
  data_dir       TEXT NOT NULL,                 -- <appData>/projects/<id>  (mongo/redis data, logs)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  archived_at    INTEGER
);

-- Secret METADATA only. Values live in the macOS Keychain:
--   service = "ai.touri.desktop.secret", account = keychain_account.
CREATE TABLE secrets (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE, -- NULL = global
  name             TEXT NOT NULL,                -- env var name, ^[A-Z_][A-Z0-9_]*$
  keychain_account TEXT NOT NULL UNIQUE,         -- "<projectId|global>/<name>"
  usage_json       TEXT NOT NULL DEFAULT '{"env":true,"browser":false}',
  browser_origin   TEXT,                         -- required when usage.browser = true
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE bots (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  title             TEXT,
  description       TEXT,
  color             TEXT,
  avatar_path       TEXT,
  avatar_shape      TEXT,
  avatar_seed       TEXT,
  instructions      TEXT NOT NULL DEFAULT '',     -- SOUL; mirrored to <botHome>/SOUL.md
  instructions_hash TEXT NOT NULL DEFAULT '',
  provider          TEXT NOT NULL CHECK (provider IN ('codex','claude')),
  model             TEXT,                         -- NULL = CLI default
  reasoning_effort  TEXT CHECK (reasoning_effort IN ('low','medium','high','xhigh')),
  access            TEXT NOT NULL DEFAULT 'workspace-write'
                    CHECK (access IN ('read-only','workspace-write','full')),
  approvals         TEXT NOT NULL DEFAULT 'on-request'
                    CHECK (approvals IN ('never','on-request')),
  project_id        TEXT REFERENCES projects(id) ON DELETE SET NULL,
  cwd               TEXT,                         -- absolute; NULL = project.path, else bot home
  home_dir          TEXT NOT NULL,                -- <appData>/bots/<id>
  main_thread_id    TEXT,                         -- set after the main thread is created
  browser_enabled   INTEGER NOT NULL DEFAULT 1,
  computer_use      INTEGER NOT NULL DEFAULT 0,   -- per-bot opt-in, default off
  notifications     TEXT NOT NULL DEFAULT 'failures' CHECK (notifications IN ('all','failures','none')),
  section           TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  paused            INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','legacy')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER
);

-- A thread is one chat. Its messages form a tree (parent_id); edits create branches.
-- The visible chat is the path from the root to active_leaf_id.
CREATE TABLE threads (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL, -- forks, routine-run chats
  kind             TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('main','chat','routine')),
  title            TEXT NOT NULL,
  active_leaf_id   TEXT,                          -- messages.id
  routine_run_id   TEXT,                          -- routine_runs.id when kind = 'routine'
  cwd_override     TEXT,
  unread           INTEGER NOT NULL DEFAULT 0,
  carryover_note   TEXT,                          -- injected into the next turn, then cleared
  usage_json       TEXT NOT NULL DEFAULT '{}',    -- cumulative ThreadUsage
  source           TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','legacy')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  archived_at      INTEGER
);
CREATE INDEX threads_bot ON threads(bot_id, updated_at DESC);

-- One native CLI session bound to a thread (one active row per thread+provider).
CREATE TABLE provider_sessions (
  id                  TEXT PRIMARY KEY,
  thread_id           TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('codex','claude')),
  external_session_id TEXT NOT NULL,              -- codex threadId / claude session_id
  rollout_path        TEXT,                       -- codex rollout file when resuming by path
  fingerprint         TEXT NOT NULL,              -- SessionFingerprint hash
  state               TEXT NOT NULL CHECK (state IN ('active','replaced','failed')),
  model               TEXT,
  created_at          INTEGER NOT NULL,
  last_used_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX provider_sessions_active
  ON provider_sessions(thread_id, provider) WHERE state = 'active';

-- One run per turn. A run is NEVER deleted, and its user message is never dropped.
CREATE TABLE runs (
  id                 TEXT PRIMARY KEY,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  bot_id             TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  trigger            TEXT NOT NULL CHECK (trigger IN ('user','routine','retry','import')),
  request_message_id TEXT,                         -- the user message that started it
  reply_message_id   TEXT,                         -- the assistant message it produced
  external_turn_id   TEXT,
  status             TEXT NOT NULL CHECK (status IN
                       ('queued','starting','running','succeeded','failed','canceled','interrupted')),
  error_class        TEXT CHECK (error_class IN
                       ('cli_missing','cli_auth','cli_crash','cli_protocol','rate_limit','context_overflow',
                        'timeout','canceled','oom','tool_error','app_restart','unknown')),
  error_message      TEXT,                         -- redacted, <= 2000 chars
  usage_json         TEXT,                         -- RunUsage (optional timings milestones; no schema migration required)
  routine_run_id     TEXT,
  queued_at          INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER
);
CREATE INDEX runs_thread ON runs(thread_id, queued_at);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE messages (
  id           TEXT NOT NULL,
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id    TEXT,                               -- NULL = root of the tree
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  kind         TEXT NOT NULL CHECK (kind IN ('text','tool','notice','approval')),
  status       TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','failed','canceled')),
  run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
  text         TEXT NOT NULL DEFAULT '',           -- plain text for search and handoff
  parts_json   TEXT NOT NULL DEFAULT '[]',         -- MessagePart[]; reasoning may include optional estimatedTokens with empty text
  sender_json  TEXT,                               -- {name, id} for routine / peer / import senders
  source       TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','legacy')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (thread_id, id)
);
CREATE INDEX messages_parent ON messages(thread_id, parent_id);
CREATE INDEX messages_run ON messages(run_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text, thread_id UNINDEXED, message_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,                   -- sha256 of content
  path        TEXT NOT NULL,                      -- <appData>/attachments/<aa>/<sha256>.<ext>
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  origin_path TEXT,                               -- source path at import time (informational)
  created_at  INTEGER NOT NULL
);

CREATE TABLE routines (
  id               TEXT PRIMARY KEY,
  bot_id           TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  prompt           TEXT NOT NULL,
  cron             TEXT NOT NULL,                  -- 5-field cron
  timezone         TEXT NOT NULL,                  -- IANA, e.g. America/Sao_Paulo
  enabled          INTEGER NOT NULL DEFAULT 0,
  continuity       TEXT NOT NULL DEFAULT 'new-thread'
                   CHECK (continuity IN ('new-thread','results-thread','main-thread')),
  results_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  timeout_minutes  INTEGER NOT NULL DEFAULT 30,
  overlap          TEXT NOT NULL DEFAULT 'skip' CHECK (overlap IN ('skip','queue')),
  catch_up_minutes INTEGER NOT NULL DEFAULT 30,    -- run a missed slot if app was down < this
  next_run_at      INTEGER,
  source           TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','legacy')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE routine_runs (
  id             TEXT PRIMARY KEY,
  routine_id     TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  scheduled_for  INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('scheduled','running','succeeded','failed','skipped','canceled')),
  thread_id      TEXT REFERENCES threads(id) ON DELETE SET NULL,
  run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('cron','manual','catch-up','import')),
  summary        TEXT,
  started_at     INTEGER,
  finished_at    INTEGER,
  UNIQUE (routine_id, scheduled_for)               -- no double-fire for one slot
);

-- Long-running processes supervised by the app (dev servers, mongod, redis...).
CREATE TABLE processes (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,                    -- unique per project, ^[a-z0-9][a-z0-9-]{0,39}$
  command        TEXT NOT NULL,                    -- run via the login shell: $SHELL -lc <command>
  cwd            TEXT NOT NULL,                    -- absolute, inside project.path or project.data_dir
  env_json       TEXT NOT NULL DEFAULT '{}',       -- {KEY: "literal" | {"secret": "NAME"}}
  autostart      INTEGER NOT NULL DEFAULT 0,
  restart        TEXT NOT NULL DEFAULT 'on-failure' CHECK (restart IN ('never','on-failure','always')),
  depends_on_json TEXT NOT NULL DEFAULT '[]',      -- process names started first
  ready_json     TEXT,                             -- {"port":N} | {"logRegex":"..."} | {"http":"url"}
  preview_port   INTEGER,                          -- pinned port for the Preview pane
  created_by     TEXT NOT NULL CHECK (created_by IN ('user','agent')),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (project_id, name)
);

-- One row per start of a process (history + orphan cleanup after a crash).
CREATE TABLE process_runs (
  id          TEXT PRIMARY KEY,
  process_id  TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  pid         INTEGER,
  pgid        INTEGER,
  pid_start   TEXT,                                -- `ps -o lstart=` value, guards PID reuse
  status      TEXT NOT NULL CHECK (status IN ('starting','running','ready','exited','crashed','stopped')),
  exit_code   INTEGER,
  signal      TEXT,
  ports_json  TEXT NOT NULL DEFAULT '[]',          -- detected listening ports
  log_path    TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX process_runs_live ON process_runs(status);

-- Agent-owned browser tabs. Survive turns and app restarts.
CREATE TABLE browser_tabs (
  id              TEXT PRIMARY KEY,               -- stable touri tab id ("t_<ulid>")
  profile         TEXT NOT NULL DEFAULT 'default',
  owner_bot_id    TEXT REFERENCES bots(id) ON DELETE SET NULL,
  owner_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  opener_tab_id   TEXT,
  cdp_target_id   TEXT,                           -- NULL while unloaded
  url             TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL CHECK (state IN ('live','unloaded','closed')),
  held_by_user    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL
);
CREATE INDEX browser_tabs_owner ON browser_tabs(owner_bot_id, state);

-- Computer-use grants: a bot may control the Mac only inside an unexpired grant.
CREATE TABLE computer_grants (
  id          TEXT PRIMARY KEY,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  thread_id   TEXT REFERENCES threads(id) ON DELETE CASCADE,
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  revoked_by  TEXT CHECK (revoked_by IN ('user','kill-switch','expiry'))
);

-- Idempotency ledger for importers.
CREATE TABLE import_records (
  source       TEXT NOT NULL,                     -- 'legacy'
  source_kind  TEXT NOT NULL CHECK (source_kind IN
                 ('bot','thread','message','routine','routine_run','attachment','codex_session','memory_file')),
  source_id    TEXT NOT NULL,
  local_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  import_id    TEXT NOT NULL,
  imported_at  INTEGER NOT NULL,
  PRIMARY KEY (source, source_kind, source_id)
);

CREATE TABLE imports (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  origin      TEXT NOT NULL,                      -- "ssh://user@host.example" or a local path
  status      TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  report_json TEXT,                               -- ImportReport
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);

-- Audit of tool calls made through the touri MCP server (args redacted).
CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
  thread_id   TEXT,
  bot_id      TEXT,
  tool        TEXT NOT NULL,
  args_json   TEXT NOT NULL,                      -- redacted
  ok          INTEGER,
  error_code  TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX tool_calls_run ON tool_calls(run_id);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Migration 0004: per-bot machines and scoped VM processes.
ALTER TABLE bots ADD COLUMN machine TEXT NOT NULL DEFAULT 'local' CHECK(machine IN ('local','vm'));
ALTER TABLE bots ADD COLUMN machine_idle_minutes INTEGER NOT NULL DEFAULT 15 CHECK(machine_idle_minutes BETWEEN 1 AND 1440);
ALTER TABLE bots ADD COLUMN vm_provider_login INTEGER NOT NULL DEFAULT 0 CHECK(vm_provider_login IN (0,1));
ALTER TABLE bots ADD COLUMN host_computer_use INTEGER NOT NULL DEFAULT 0 CHECK(host_computer_use IN (0,1));
CREATE TABLE bot_machines (bot_id TEXT PRIMARY KEY REFERENCES bots(id), vm_id TEXT NOT NULL UNIQUE, volume TEXT NOT NULL, project_id TEXT, created_ms REAL, start_ms REAL);
ALTER TABLE processes ADD COLUMN vm_bot_id TEXT REFERENCES bots(id);
UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';

-- Migration 0005: editable role line.
ALTER TABLE bots ADD COLUMN role_line TEXT;
UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';

-- Migration 0006: external MCP servers attached to a single bot.
CREATE TABLE bot_mcp_servers (
  bot_id TEXT NOT NULL REFERENCES bots(id),
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  PRIMARY KEY (bot_id, name)
);
UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';

-- Group actions use notice parts (group_ask_all / group_summary) in messages.parts_json.
-- Run.groupTurnId is a read projection of group_run_links.turn_id; no extra persisted state.
-- ApprovalPart.groupMemberId is optional metadata in messages.parts_json for delegation waiting states.
