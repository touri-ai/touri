// Scan primary-key windows so even unrelated history cannot enlarge a transaction.
export const botDeletionRecordTasks = getBotDeletionRecordTasks()

function getBotDeletionRecordTasks() {
  const thread = getOwnedThread
  const run = getOwnedRun
  const notification = `EXISTS (SELECT 1 FROM notifications owner
    WHERE owner.id = notification_id AND owner.bot_id = ?2)`
  const routine = `EXISTS (SELECT 1 FROM routines owner
    WHERE owner.id = routine_runs.routine_id AND owner.bot_id = ?2)`

  return [
    { table: "group_run_links", predicate: `${run("run_id")} OR ${run("turn_id")}` },
    { table: "group_turns", predicate: run("run_id") },
    { table: "send_journal", predicate: run("run_id"), update: "run_id = NULL" },
    { table: "tool_resolutions", predicate: `${run("run_id")} OR ${thread("tool_resolutions.thread_id")}` },
    { table: "tool_calls", predicate: "bot_id = ?2" },
    { table: "tool_calls", predicate: run("run_id"), update: "run_id = NULL" },
    { table: "notification_log", predicate: notification },
    { table: "recovery_tasks", predicate: notification },
    { table: "notifications", predicate: "bot_id = ?2" },
    {
      table: "process_runs",
      predicate: "EXISTS (SELECT 1 FROM processes owner WHERE owner.id = process_id AND owner.vm_bot_id = ?2)",
    },
    { table: "processes", predicate: "vm_bot_id = ?2" },
    { table: "browser_tabs", predicate: "owner_bot_id = ?2" },
    { table: "browser_tabs", predicate: thread("owner_thread_id"), update: "owner_thread_id = NULL" },
    { table: "group_message_links", predicate: thread("source_thread_id") },
    { table: "send_journal", predicate: thread("send_journal.thread_id") },
    { table: "rejections", predicate: thread("rejections.thread_id") },
    { table: "transcript_retention", predicate: thread("transcript_retention.thread_id") },
    { table: "transcript_pending_deltas", predicate: thread("transcript_pending_deltas.thread_id") },
    { table: "provider_sessions", predicate: thread("provider_sessions.thread_id") },
    { table: "computer_grants", predicate: `bot_id = ?2 OR ${thread("computer_grants.thread_id")}` },
    { table: "routine_runs", predicate: routine },
    { table: "routine_runs", predicate: thread("routine_runs.thread_id"), update: "thread_id = NULL" },
    { table: "routine_runs", predicate: run("run_id"), update: "run_id = NULL" },
    { table: "routines", predicate: "bot_id = ?2" },
    { table: "routines", predicate: thread("results_thread_id"), update: "results_thread_id = NULL" },
    { table: "runs", predicate: `bot_id = ?2 OR ${thread("runs.thread_id")}` },
    { table: "threads", predicate: thread("threads.parent_thread_id"), update: "parent_thread_id = NULL" },
    { table: "threads", predicate: thread("threads.group_thread_id"), update: "group_thread_id = NULL" },
    { table: "bot_mcp_servers", predicate: "bot_id = ?2" },
    { table: "cloud_runs", predicate: "bot_id = ?2" },
    { table: "cloud_machines", predicate: "bot_id = ?2" },
    { table: "group_members", predicate: "bot_id = ?2" },
    { table: "bot_groups", predicate: "coordinator_bot_id = ?2", update: "coordinator_bot_id = NULL" },
    { table: "threads", predicate: "bot_id = ?2" },
  ]
}

function getOwnedThread(column: string): string {
  return `EXISTS (SELECT 1 FROM threads owned_thread WHERE owned_thread.id = ${column} AND owned_thread.bot_id = ?2)`
}

function getOwnedRun(column: string): string {
  return `EXISTS (SELECT 1 FROM runs owned_run WHERE owned_run.id = ${column}
    AND (owned_run.bot_id = ?2 OR ${getOwnedThread("owned_run.thread_id")}))`
}
