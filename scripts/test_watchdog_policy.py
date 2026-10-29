import sqlite3
import unittest

from watchdog_policy import cancel_overdue_run, get_overdue_runs

MINUTE = 60_000
NOW = 200 * MINUTE


class WatchdogPolicyTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE runs (id TEXT, bot_id TEXT, started_at INTEGER,
                trigger TEXT, routine_run_id TEXT, status TEXT);
            CREATE TABLE routine_runs (id TEXT, routine_id TEXT, started_at INTEGER);
            CREATE TABLE routines (id TEXT, timeout_minutes INTEGER);
            CREATE TABLE group_turns (run_id TEXT);
            CREATE TABLE group_run_links (run_id TEXT);
            INSERT INTO routines VALUES ('routine', 90);
            INSERT INTO routine_runs VALUES ('execution', 'routine', 8100000);
        """)

    def add_run(self, age=65, trigger="routine", execution="execution", status="running"):
        self.db.execute("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)",
                        ("run", "bot", NOW - age * MINUTE, trigger, execution, status))

    def test_routine_at_65_minutes_keeps_its_90_minute_budget(self):
        self.add_run()

        result = get_overdue_runs(self.db, NOW, {})

        self.assertEqual(result, ())

    def test_routine_expires_after_90_minutes_even_with_longer_bot_limit(self):
        self.add_run()

        result = get_overdue_runs(self.db, NOW + 26 * MINUTE, {"bot": 300})

        self.assertEqual(result[0]["limit_minutes"], 90)
        self.assertEqual(result[0]["age_minutes"], 91)

    def test_resumed_run_does_not_reset_routine_deadline(self):
        self.add_run(age=1)

        result = get_overdue_runs(self.db, NOW + 26 * MINUTE, {})

        self.assertEqual(result[0]["age_minutes"], 91)

    def test_direct_run_retains_default_and_bot_override(self):
        self.add_run(trigger="user", execution=None)

        expired = get_overdue_runs(self.db, NOW, {})
        within_override = get_overdue_runs(self.db, NOW, {"bot": 300})

        self.assertEqual(expired[0]["limit_minutes"], 60)
        self.assertEqual(within_override, ())

    def test_channel_coordinator_at_62_minutes_keeps_runtime_deadline(self):
        self.add_run(age=62, trigger="user", execution=None)
        self.db.execute("INSERT INTO group_turns VALUES ('run')")

        result = get_overdue_runs(self.db, NOW, {})

        self.assertEqual(result, ())

    def test_delegated_channel_member_keeps_runtime_deadline(self):
        self.add_run(age=62, trigger="user", execution=None)
        self.db.execute("INSERT INTO group_run_links VALUES ('run')")

        result = get_overdue_runs(self.db, NOW, {})

        self.assertEqual(result, ())

    def test_channel_routine_still_expires_at_its_absolute_deadline(self):
        self.add_run()
        self.db.execute("INSERT INTO group_turns VALUES ('run')")

        result = get_overdue_runs(self.db, NOW + 26 * MINUTE, {})

        self.assertEqual(result[0]["limit_minutes"], 90)

    def test_missing_routine_metadata_does_not_fall_back_to_60_minutes(self):
        self.add_run(execution="missing")

        result = get_overdue_runs(self.db, NOW, {})

        self.assertEqual(result, ())

    def test_terminal_run_is_not_canceled(self):
        self.add_run(age=150, status="succeeded")

        result = get_overdue_runs(self.db, NOW, {})

        self.assertEqual(result, ())

    def test_cancellation_failure_is_not_reported_as_confirmed(self):
        candidate = {"run_id": "run"}

        def cancel(_):
            raise OSError("HTTP 503")

        result = cancel_overdue_run(candidate, cancel)

        self.assertFalse(result["cancellation_confirmed"])

    def test_successful_cancellation_is_confirmed(self):
        result = cancel_overdue_run(
            {"run_id": "run"}, lambda _: {"run": {"id": "run", "status": "canceled"}})

        self.assertTrue(result["cancellation_confirmed"])

    def test_successful_response_for_finished_run_is_not_a_cancellation(self):
        result = cancel_overdue_run(
            {"run_id": "run"}, lambda _: {"run": {"id": "run", "status": "succeeded"}})

        self.assertFalse(result["cancellation_confirmed"])

    def test_successful_response_for_running_run_is_not_a_cancellation(self):
        result = cancel_overdue_run(
            {"run_id": "run"}, lambda _: {"run": {"id": "run", "status": "running"}})

        self.assertFalse(result["cancellation_confirmed"])

    def test_response_without_run_state_is_unconfirmed(self):
        result = cancel_overdue_run({"run_id": "run"}, lambda _: None)

        self.assertFalse(result["cancellation_confirmed"])

    def test_malformed_run_state_is_unconfirmed(self):
        result = cancel_overdue_run({"run_id": "run"}, lambda _: {"run": "canceled"})

        self.assertFalse(result["cancellation_confirmed"])

    def test_response_for_another_run_is_unconfirmed(self):
        result = cancel_overdue_run(
            {"run_id": "run"}, lambda _: {"run": {"id": "other", "status": "canceled"}})

        self.assertFalse(result["cancellation_confirmed"])


if __name__ == "__main__":
    unittest.main()
