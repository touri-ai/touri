-- A local bot may sign in with its own provider login profile instead of the host's default CLI login.
-- claude.ai connectors are opt-in per bot because they bypass the touri MCP gateway.
ALTER TABLE bots ADD COLUMN provider_profile TEXT;
ALTER TABLE bots ADD COLUMN claude_ai_connectors INTEGER NOT NULL DEFAULT 0 CHECK (claude_ai_connectors IN (0, 1));
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '17');
