CREATE TABLE bot_deletions (
  bot_id TEXT PRIMARY KEY,
  delete_volumes INTEGER NOT NULL CHECK (delete_volumes IN (0, 1)),
  phase TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  high_water INTEGER NOT NULL DEFAULT 0,
  attachment_page INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  file_cursor TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE bot_deletion_attachments (
  bot_id TEXT NOT NULL REFERENCES bot_deletions(bot_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  PRIMARY KEY (bot_id, attachment_id)
);
-- Bound file pagination and foreign-key checks after the worker removes dependents.
CREATE INDEX threads_bot_id ON threads(bot_id, id);
CREATE INDEX threads_parent ON threads(parent_thread_id);
CREATE INDEX provider_sessions_thread ON provider_sessions(thread_id);
CREATE INDEX provider_sessions_rollout ON provider_sessions(rollout_path, thread_id);
CREATE INDEX provider_sessions_cleanup ON provider_sessions(thread_id, id) WHERE rollout_path IS NOT NULL;
CREATE INDEX runs_bot ON runs(bot_id);
CREATE INDEX routines_bot ON routines(bot_id);
CREATE INDEX routines_results_thread ON routines(results_thread_id);
CREATE INDEX routine_runs_thread ON routine_runs(thread_id);
CREATE INDEX routine_runs_run ON routine_runs(run_id);
CREATE INDEX processes_vm_bot ON processes(vm_bot_id);
CREATE INDEX process_runs_process ON process_runs(process_id);
CREATE INDEX computer_grants_bot ON computer_grants(bot_id);
CREATE INDEX computer_grants_thread ON computer_grants(thread_id);
CREATE INDEX browser_tabs_thread ON browser_tabs(owner_thread_id);
CREATE INDEX cloud_runs_bot ON cloud_runs(bot_id);
CREATE INDEX bot_groups_coordinator ON bot_groups(coordinator_bot_id);
CREATE INDEX send_journal_run ON send_journal(run_id);
CREATE INDEX group_run_links_turn ON group_run_links(turn_id);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('bot_deletion_version', '1');
UPDATE schema_meta SET value = '35' WHERE key = 'schema_version';
