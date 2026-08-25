"""Pure refresh-state transitions for Instagram artist profiles."""

from __future__ import annotations

import re
from typing import Any, Mapping


DEFAULT_DEAD_THRESHOLD = 3
DEAD_STATUSES = frozenset({"not_found", "private"})
OBSERVATION_RANK = {
    "transient": 1,
    "not_found": 2,
    "private": 2,
    "active": 3,
}
NOT_FOUND = re.compile(
    r"not[\s_-]?found|does not exist|doesn't exist|no such user|"
    r"user unavailable|account (?:has been )?disabled|deleted account",
    re.I,
)
PRIVATE = re.compile(r"private account|account is private|profile is private", re.I)


def normalize_handle(raw: Any) -> str:
    return str(raw or "").strip().lstrip("@").lower()


def classify_scrape_result(row: Mapping[str, Any] | None) -> tuple[str, str | None]:
    """Classify an actor row without treating absence as confirmed death."""

    if row is None:
        return "transient", "actor-returned-no-row"
    if bool(row.get("private") or row.get("isPrivate")):
        return "private", "profile-private"

    error = " ".join(
        str(row.get(key) or "")
        for key in ("error", "errorDescription", "errorMessage", "message")
    ).strip()
    if error:
        if PRIVATE.search(error):
            return "private", error
        if NOT_FOUND.search(error):
            return "not_found", error
        return "transient", error

    if normalize_handle(row.get("username") or row.get("handle")):
        return "active", None
    return "transient", "actor-row-missing-username"


def update_handle_state(
    previous: Mapping[str, Any] | None,
    *,
    status: str,
    checked_at: str,
    reason: str | None = None,
    dead_threshold: int = DEFAULT_DEAD_THRESHOLD,
    observation_sweep_id: str | None = None,
) -> dict[str, Any]:
    """Apply at most one observation per handle and sweep.

    Actor retries and overlapping workers can report the same handle more than
    once. A sweep therefore gets one vote toward the dead threshold.
    """

    if status not in {"active", "not_found", "private", "transient"}:
        raise ValueError(f"unknown refresh status: {status}")
    if dead_threshold < 1:
        raise ValueError("dead_threshold must be at least 1")

    state = dict(previous or {})
    same_sweep = bool(
        observation_sweep_id
        and state.get("lastObservationSweepId") == observation_sweep_id
    )
    if same_sweep:
        previous_status = str(state.get("lastRefreshStatus") or "transient")
        if OBSERVATION_RANK[status] <= OBSERVATION_RANK.get(previous_status, 1):
            return state
        previous_dead = int(
            state.get(
                "sweepBaselineConsecutiveDeadRefreshes",
                state.get("consecutiveDeadRefreshes") or 0,
            )
        )
        was_stale = bool(
            state.get("sweepBaselineStale", state.get("stale"))
        )
    else:
        previous_dead = int(state.get("consecutiveDeadRefreshes") or 0)
        was_stale = bool(state.get("stale"))
        if observation_sweep_id:
            state["sweepBaselineConsecutiveDeadRefreshes"] = previous_dead
            state["sweepBaselineStale"] = was_stale

    state.update(
        {
            "lastRefreshStatus": status,
            "lastRefreshAt": checked_at,
            "lastRefreshReason": reason,
        }
    )
    if observation_sweep_id:
        state["lastObservationSweepId"] = observation_sweep_id

    if status == "active":
        state.update(
            {
                "consecutiveDeadRefreshes": 0,
                "stale": False,
                "lastSeenAt": checked_at,
            }
        )
    elif status in DEAD_STATUSES:
        consecutive = previous_dead + 1
        state.update(
            {
                "consecutiveDeadRefreshes": consecutive,
                "stale": True if consecutive >= dead_threshold else was_stale,
            }
        )
    else:
        # A network/actor failure is not evidence that an artist disappeared.
        # It also breaks a sequence of confirmed dead observations.  Once an
        # artist is stale, only a confirmed active profile clears that status.
        state.update(
            {
                "consecutiveDeadRefreshes": 0,
                "stale": was_stale,
            }
        )
    return state
