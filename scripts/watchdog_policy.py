"""Offline watchdog policy. The caller owns read-only DB access and authenticated cancellation."""


def get_overdue_runs(connection, now, bot_limits, default_limit=60):
    # Routine deadlines belong to the routine execution, including resumed runs.
    rows = connection.execute("""
        SELECT r.id, r.bot_id, r.started_at, r.trigger,
               rr.started_at, routine.timeout_minutes,
               EXISTS (SELECT 1 FROM group_turns WHERE run_id = r.id)
                 OR EXISTS (SELECT 1 FROM group_run_links WHERE run_id = r.id)
        FROM runs r
        LEFT JOIN routine_runs rr ON rr.id = r.routine_run_id
        LEFT JOIN routines routine ON routine.id = rr.routine_id
        WHERE r.status = 'running' AND r.started_at IS NOT NULL
    """)
    return tuple(
        candidate
        for row in rows
        if (candidate := get_overdue_run(row, now, bot_limits, default_limit)) is not None
    )


def get_overdue_run(row, now, bot_limits, default_limit):
    run_id, bot_id, started, trigger, routine_started, routine_limit, is_channel = row
    if trigger == "routine" and (routine_limit is None or routine_started is None):
        # Missing routine metadata cannot authorize a shorter bot-level deadline.
        return None

    # Channel coordination and delegation own finite runtime deadlines, including host overrides.
    # The external watchdog cannot infer those deadlines from a generic per-bot age limit.
    if is_channel and routine_limit is None:
        return None

    is_routine = routine_limit is not None and routine_started is not None
    limit = routine_limit if is_routine else bot_limits.get(bot_id, default_limit)
    origin = routine_started if is_routine else started
    age = (now - origin) / 60_000
    if age <= limit:
        return None

    return {"run_id": run_id, "bot_id": bot_id, "age_minutes": age, "limit_minutes": limit}


def cancel_overdue_run(candidate, cancel):
    """Only the requested run's canceled state confirms a cancellation notice."""
    try:
        result = cancel(candidate["run_id"])
    except Exception:
        return dict(candidate, cancellation_confirmed=False)

    run = result.get("run") if isinstance(result, dict) else None
    is_confirmed = (
        isinstance(run, dict)
        and run.get("id") == candidate["run_id"]
        and run.get("status") == "canceled"
    )
    return dict(candidate, cancellation_confirmed=is_confirmed)
