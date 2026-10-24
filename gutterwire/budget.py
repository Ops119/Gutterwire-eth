"""Rate limiting and daily budget tracking, persisted in SQLite so they hold across cron runs."""
from __future__ import annotations

import sqlite3
import time


class BudgetExceeded(Exception):
    """Raised when an API's daily budget is used up. Callers skip that work until tomorrow (UTC)."""


class Budget:
    def __init__(self, conn: sqlite3.Connection, per_minute: dict, per_day: dict, sleep=time.sleep):
        self.conn = conn
        self.per_minute = per_minute
        self.per_day = per_day
        self.sleep = sleep

    def _count_since(self, api: str, since: float) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM api_calls WHERE api=? AND ts>=?", (api, since)
        ).fetchone()
        return row["n"]

    def used_today(self, api: str) -> int:
        day_start = time.time() // 86400 * 86400
        return self._count_since(api, day_start)

    def remaining_today(self, api: str) -> int:
        return max(0, self.per_day.get(api, 10**9) - self.used_today(api))

    def acquire(self, api: str) -> None:
        """Block until a call to `api` fits the per-minute limit, then record it.

        Raises BudgetExceeded if the daily budget is spent.
        """
        if self.remaining_today(api) <= 0:
            raise BudgetExceeded(f"{api}: daily budget of {self.per_day.get(api)} used")
        limit = self.per_minute.get(api)
        if limit:
            while True:
                window_start = time.time() - 60
                n = self._count_since(api, window_start)
                if n < limit:
                    break
                oldest = self.conn.execute(
                    "SELECT ts FROM api_calls WHERE api=? AND ts>=? ORDER BY ts LIMIT 1",
                    (api, window_start),
                ).fetchone()["ts"]
                self.sleep(max(0.5, oldest + 60 - time.time()))
        self.conn.execute("INSERT INTO api_calls(api, ts) VALUES (?, ?)", (api, time.time()))
        self.conn.commit()

    def prune(self, keep_days: int = 7) -> None:
        self.conn.execute("DELETE FROM api_calls WHERE ts < ?", (time.time() - keep_days * 86400,))
        self.conn.commit()

    def report(self) -> dict:
        return {api: f"{self.used_today(api)}/{cap}" for api, cap in self.per_day.items()}
