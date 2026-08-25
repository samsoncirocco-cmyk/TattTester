#!/usr/bin/env python3
"""Auditable Instagram enrichment and refresh-state collection.

Reads the ranked artist queue, scrapes profiles in chunks through Apify, and
writes one accepted profile per artist for ``scripts/host-artist-images.mjs``.

The account-quality gate is on by default.  Rejected/dead profiles are logged
to JSONL and existing profile files are moved to a recoverable quarantine so
an idempotent host-all run cannot accidentally re-import them.  ``--no-filter``
is an explicit operator override; it is recorded on every bypassed output.

No graph or production database writes happen here.  The refresh-state ledger
is applied separately by the dry-run-by-default TatT operator tool.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

try:
    from execution.ig_quality import looks_bookable
    from execution.ig_refresh_state import (
        DEFAULT_DEAD_THRESHOLD,
        classify_scrape_result,
        normalize_handle,
        update_handle_state,
    )
except ModuleNotFoundError:  # direct ``python execution/apify_ig_enrich.py``
    from ig_quality import looks_bookable
    from ig_refresh_state import (
        DEFAULT_DEAD_THRESHOLD,
        classify_scrape_result,
        normalize_handle,
        update_handle_state,
    )


ACTOR = "apify~instagram-profile-scraper"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "enrichment" / "instagram" / "apify-profiles"
DEFAULT_LEDGER = ROOT / "data" / "enrichment" / "instagram" / "refresh-status.json"
DEFAULT_AUDIT = ROOT / "data" / "enrichment" / "instagram" / "refresh-audit.jsonl"
DEFAULT_REPORT = ROOT / "data" / "enrichment" / "instagram" / "apify-run-report.json"
TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_token() -> str:
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if token:
        return token
    raise RuntimeError("APIFY_TOKEN is required")


def load_required_queue(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        raise RuntimeError(f"artist queue does not exist: {path}")
    try:
        queue = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"artist queue is not valid JSON: {path}") from error
    if not isinstance(queue, list) or not queue:
        raise RuntimeError(f"artist queue must be a non-empty JSON array: {path}")

    invalid = []
    handles = set()
    artist_ids = set()
    for index, item in enumerate(queue):
        artist_id = str(item.get("id") or "").strip() if isinstance(item, dict) else ""
        handle = normalize_handle(item.get("ig")) if isinstance(item, dict) else ""
        if not artist_id or not handle or handle in handles or artist_id in artist_ids:
            invalid.append(index)
            continue
        handles.add(handle)
        artist_ids.add(artist_id)
    if invalid:
        raise RuntimeError(
            "artist queue has missing or duplicate id/ig records at indexes: "
            f"{invalid[:10]}"
        )
    return queue


def api(
    method: str,
    url: str,
    body: Any = None,
    timeout: int = 120,
    *,
    token: str,
) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def run_chunk(
    usernames: list[str],
    token: str,
    *,
    attempt_id: str,
    checked_at: str,
    checkpoint: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run one paid actor chunk while durably checkpointing spend evidence."""

    attempt = {
        "attemptId": attempt_id,
        "id": None,
        "status": "POSTING",
        "terminal": False,
        "usageTotalUsd": None,
        "requestedCount": len(usernames),
        "startedAt": checked_at,
        "spendStatus": "ambiguous",
    }
    # If the process dies during POST, the operator can still see that spend
    # may have occurred. Do not launch until this checkpoint is durable.
    checkpoint(attempt)
    try:
        response = api(
            "POST",
            f"https://api.apify.com/v2/acts/{ACTOR}/runs",
            {"usernames": usernames},
            token=token,
        )
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        failed = {**attempt, "status": "POST_ERROR", "error": str(error)}
        checkpoint(failed)
        raise

    run = dict(response.get("data") or {})
    run_id = run.get("id")
    dataset_id = run.get("defaultDatasetId")
    if not run_id or not dataset_id:
        malformed = {
            **attempt,
            **run,
            "status": "MALFORMED_POST_RESPONSE",
            "terminal": False,
            "spendStatus": "ambiguous",
        }
        checkpoint(malformed)
        raise RuntimeError("Apify actor POST returned no run or dataset ID")

    final = {
        **attempt,
        **run,
        "attemptId": attempt_id,
        "id": run_id,
        "terminal": str(run.get("status") or "") in TERMINAL_STATUSES,
        "spendStatus": "identified",
    }
    checkpoint(final)
    try:
        for _ in range(120):
            polled = dict(
                api(
                    "GET",
                    f"https://api.apify.com/v2/actor-runs/{run_id}",
                    token=token,
                )["data"]
            )
            final = {
                **final,
                **polled,
                "attemptId": attempt_id,
                "id": run_id,
                "terminal": str(polled.get("status") or "") in TERMINAL_STATUSES,
                "spendStatus": "identified",
            }
            if final["terminal"]:
                checkpoint(final)
                break
            time.sleep(5)
        else:
            checkpoint(final)

        if final.get("status") != "SUCCEEDED":
            return final, []
        try:
            items = api(
                "GET",
                f"https://api.apify.com/v2/datasets/{dataset_id}/items?clean=true",
                token=token,
            )
            return final, items
        except (OSError, RuntimeError, urllib.error.URLError) as error:
            failed_dataset = {**final, "dataError": str(error)}
            checkpoint(failed_dataset)
            return failed_dataset, []
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        failed = {
            **final,
            "status": "POLL_ERROR",
            "terminal": False,
            "error": str(error),
        }
        checkpoint(failed)
        return failed, []


def extract_images(row: Mapping[str, Any]) -> list[str]:
    images: list[str] = []
    for post in row.get("latestPosts") or []:
        url = post.get("displayUrl") or post.get("imageUrl")
        if isinstance(url, str) and url.startswith(("http://", "https://")) and url not in images:
            images.append(url)
    return images[:8]


def row_handle(row: Mapping[str, Any]) -> str:
    direct = normalize_handle(
        row.get("username")
        or row.get("handle")
        or row.get("requestedUsername")
        or row.get("input")
    )
    if direct and "/" not in direct:
        return direct
    input_url = str(row.get("inputUrl") or row.get("url") or "")
    if "instagram.com/" in input_url:
        path = urllib.parse.urlparse(input_url).path.strip("/").split("/")[0]
        return normalize_handle(path)
    return ""


def build_chunk_observations(
    requested_handles: Iterable[str],
    items: Iterable[Mapping[str, Any]],
    actor_status: str,
) -> dict[str, tuple[str, str | None, Mapping[str, Any] | None]]:
    """Pair every requested handle with an active/dead/transient observation."""

    requested = [normalize_handle(handle) for handle in requested_handles]
    rows = {row_handle(row): row for row in items if row_handle(row)}
    observations = {}
    for handle in requested:
        row = rows.get(handle)
        status, reason = classify_scrape_result(row)
        if row is None:
            reason = f"actor-{actor_status.lower()}-returned-no-row"
        observations[handle] = (status, reason, row)
    return observations


def make_profile_record(
    *,
    artist_id: str,
    handle: str,
    row: Mapping[str, Any],
    verdict: bool,
    filter_reason: str,
    filter_bypassed: bool,
    refreshed_at: str,
) -> dict[str, Any]:
    return {
        "artistId": artist_id,
        "handle": handle,
        "bio": row.get("biography") or row.get("bio") or None,
        "followers": row.get("followersCount") or row.get("followers"),
        "posts": row.get("postsCount") or row.get("posts"),
        "profilePic": row.get("profilePicUrlHD") or row.get("profilePicUrl"),
        "images": extract_images(row),
        "looksBookable": verdict,
        "filterReason": filter_reason,
        "filterBypassed": filter_bypassed,
        "refreshedAt": refreshed_at,
    }


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def update_json_locked(path: Path, fallback: Any, updater: Any) -> Any:
    """Read/merge/write JSON while holding a process-safe sidecar lock."""

    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        current = load_json(path, fallback)
        updated = updater(current)
        write_json_atomic(path, updated)
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return updated


def append_audit_once(
    path: Path,
    record: Mapping[str, Any],
    *,
    event_id: str,
) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        stream.seek(0)
        for line in stream:
            try:
                if json.loads(line).get("eventId") == event_id:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
                    return False
            except json.JSONDecodeError:
                continue
        stream.seek(0, os.SEEK_END)
        stream.write(json.dumps({**record, "eventId": event_id}, sort_keys=True) + "\n")
        stream.flush()
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
    return True


def quarantine_profile(output_dir: Path, artist_id: str) -> bool:
    current = output_dir / f"{artist_id}.json"
    if not current.exists():
        return False
    quarantine = output_dir / "quarantine"
    quarantine.mkdir(parents=True, exist_ok=True)
    current.replace(quarantine / current.name)
    return True


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--execute",
        action="store_true",
        help="authorize paid Apify calls and local artifact writes",
    )
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument(
        "--count",
        type=int,
        default=None,
        help="records to process; defaults to the rest of the explicit queue",
    )
    parser.add_argument("--chunk", type=int, default=100)
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--status-ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--audit-log", type=Path, default=DEFAULT_AUDIT)
    parser.add_argument("--run-report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--sweep-id",
        default=None,
        help="cost/report grouping key; defaults to the UTC run date",
    )
    parser.add_argument("--dead-threshold", type=int, default=DEFAULT_DEAD_THRESHOLD)
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="deliberately enrich non-bookable profiles; bypass is audited",
    )
    args = parser.parse_args(argv)
    if args.dead_threshold < 1:
        parser.error("--dead-threshold must be at least 1")
    if args.start < 0:
        parser.error("--start cannot be negative")
    if args.count is not None and args.count < 1:
        parser.error("--count must be at least 1")
    if args.chunk < 1:
        parser.error("--chunk must be at least 1")
    return args


def merge_run_report(
    existing: Mapping[str, Any] | None,
    *,
    sweep_id: str,
    checked_at: str,
    run_slice: Mapping[str, Any],
    summary: Mapping[str, Any],
    actor_runs: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Accumulate one multi-process sweep without double-counting actor run IDs."""

    actor_runs = tuple(actor_runs)
    report = dict(existing or {})
    sweeps = dict(report.get("sweeps") or {})
    sweep = dict(sweeps.get(sweep_id) or {})
    def run_key(run: Mapping[str, Any]) -> str | None:
        if run.get("attemptId"):
            return f"attempt:{run['attemptId']}"
        if run.get("id"):
            return f"run:{run['id']}"
        return None

    by_attempt = {
        key: dict(run)
        for run in sweep.get("actorRuns") or []
        if (key := run_key(run))
    }
    for run in actor_runs:
        key = run_key(run)
        if not key:
            continue
        current = by_attempt.get(key)
        if current and current.get("terminal") and not run.get("terminal"):
            continue
        by_attempt[key] = dict(run)

    def numeric_cost(value: Any) -> float | None:
        if isinstance(value, bool):
            return None
        try:
            parsed = float(value) if value is not None else None
        except (TypeError, ValueError):
            return None
        if parsed is None or not math.isfinite(parsed) or parsed < 0:
            return None
        return parsed

    costs = [
        cost
        for run in by_attempt.values()
        if (cost := numeric_cost(run.get("usageTotalUsd"))) is not None
    ]
    missing_cost_count = len(by_attempt) - len(costs)
    nonterminal_count = sum(
        1
        for run in by_attempt.values()
        if not bool(run.get("terminal"))
        or str(run.get("status") or "") not in TERMINAL_STATUSES
    )
    ambiguous_count = sum(
        1
        for run in by_attempt.values()
        if not run.get("id") or run.get("spendStatus") == "ambiguous"
    )
    complete = bool(by_attempt) and not (
        missing_cost_count or nonterminal_count or ambiguous_count
    )
    pricing_status = (
        "no-runs"
        if not by_attempt
        else "complete"
        if complete
        else "incomplete"
    )
    sweep.update(
        {
            "startedAt": sweep.get("startedAt") or checked_at,
            "lastRunAt": checked_at,
            "actorRuns": sorted(
                by_attempt.values(),
                key=lambda run: str(run.get("attemptId") or run.get("id")),
            ),
            "apifyUsageKnownSubtotalUsd": sum(costs),
            "apifyUsageMissingRunCount": missing_cost_count,
            "apifyUsageNonterminalRunCount": nonterminal_count,
            "apifyUsageAmbiguousAttemptCount": ambiguous_count,
            "apifyUsagePricingStatus": pricing_status,
            "apifyUsageTotalUsd": sum(costs) if pricing_status == "complete" else None,
            # Preserve a value an operator added from the billing export.
            "gcsCostUsd": sweep.get("gcsCostUsd"),
            "gcsCostNote": sweep.get("gcsCostNote")
            or "Capture from the GCS billing export after hosting; not guessed here.",
            "lastInvocation": {
                "slice": dict(run_slice),
                "summary": dict(summary),
                "actorRuns": [dict(run) for run in actor_runs],
            },
        }
    )
    sweeps[sweep_id] = sweep
    return {"version": 2, "sweeps": sweeps}


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    full_queue = load_required_queue(args.queue)
    if args.start >= len(full_queue):
        raise RuntimeError(
            f"--start {args.start} is outside queue with {len(full_queue)} records"
        )
    stop = len(full_queue) if args.count is None else args.start + args.count
    queue = full_queue[args.start:stop]
    by_handle = {
        normalize_handle(item.get("ig")): str(item["id"])
        for item in queue
    }
    handles = list(by_handle)
    if not handles:
        raise RuntimeError("selected queue slice contains no valid artist handles")
    checked_at = utc_now()
    sweep_id = args.sweep_id or checked_at[:10]
    run_slice = {
        "start": args.start,
        "count": len(queue),
        "requested": len(handles),
        "queueRecords": len(full_queue),
    }
    if not args.execute:
        print(
            "DRY RUN: no paid calls or artifact writes; "
            f"slice={args.start}:{args.start + len(queue)} handles={len(handles)} "
            f"chunk={args.chunk} sweep={sweep_id}. Pass --execute to run."
        )
        return 0

    token = load_token()
    args.out.mkdir(parents=True, exist_ok=True)
    summary = {
        "requested": len(handles),
        "written": 0,
        "rejected": 0,
        "dead": 0,
        "transient": 0,
        "quarantined": 0,
        "withImages": 0,
    }
    actor_runs: dict[str, dict[str, Any]] = {}

    def checkpoint_actor_run(record: Mapping[str, Any]) -> None:
        attempt_id = str(record.get("attemptId") or "")
        if not attempt_id:
            raise RuntimeError("paid-run checkpoint is missing attemptId")
        actor_runs[attempt_id] = dict(record)
        update_json_locked(
            args.run_report,
            {},
            lambda current: merge_run_report(
                current,
                sweep_id=sweep_id,
                checked_at=checked_at,
                run_slice=run_slice,
                summary=summary,
                actor_runs=[record],
            ),
        )

    print(
        f"START Apify enrich slice={args.start}:{args.start + len(queue)} "
        f"handles={len(handles)} chunk={args.chunk} filter={not args.no_filter}"
    )
    for offset in range(0, len(handles), args.chunk):
        chunk = handles[offset : offset + args.chunk]
        attempt_id = (
            f"{sweep_id}:{args.start + offset}:{uuid.uuid4().hex}"
        )
        try:
            run, items = run_chunk(
                chunk,
                token,
                attempt_id=attempt_id,
                checked_at=checked_at,
                checkpoint=checkpoint_actor_run,
            )
            actor_status = str(run.get("status") or "UNKNOWN")
        except (OSError, RuntimeError, urllib.error.URLError) as error:
            actor_status = "ERROR"
            items = []
            if attempt_id not in actor_runs:
                checkpoint_actor_run(
                    {
                        "attemptId": attempt_id,
                        "id": None,
                        "status": "UNRECORDED_ERROR",
                        "terminal": False,
                        "usageTotalUsd": None,
                        "spendStatus": "ambiguous",
                        "error": str(error),
                    }
                )

        observations = build_chunk_observations(chunk, items, actor_status)
        evaluations = {}
        for handle, (status, refresh_reason, row) in observations.items():
            verdict = None
            filter_reason = None
            if status == "active" and row is not None:
                verdict, filter_reason = looks_bookable(row)
            evaluations[handle] = (
                status,
                refresh_reason,
                row,
                verdict,
                filter_reason,
            )

        def merge_ledger(current: Mapping[str, Any] | None) -> dict[str, Any]:
            ledger = dict(current or {})
            ledger_handles = dict(ledger.get("handles") or {})
            for handle, (
                status,
                refresh_reason,
                _row,
                verdict,
                filter_reason,
            ) in evaluations.items():
                previous = ledger_handles.get(handle)
                state = update_handle_state(
                    previous,
                    status=status,
                    checked_at=checked_at,
                    reason=refresh_reason,
                    dead_threshold=args.dead_threshold,
                    observation_sweep_id=sweep_id,
                )
                selected_status = str(state.get("lastRefreshStatus") or "")
                if selected_status != status:
                    continue
                effects_complete = bool(
                    previous
                    and previous.get("lastEffectsSweepId") == sweep_id
                    and previous.get("lastEffectsStatus") == selected_status
                )
                if previous is not None and state == previous and effects_complete:
                    continue

                artist_id = by_handle[handle]
                state["artistId"] = by_handle[handle]
                if verdict is not None:
                    state["looksBookable"] = verdict
                    state["bookabilityReason"] = filter_reason

                audit = {
                    "artistId": artist_id,
                    "handle": handle,
                    "observedAt": checked_at,
                    "sweepId": sweep_id,
                    "refreshStatus": status,
                    "refreshReason": refresh_reason,
                    "stale": state["stale"],
                    "consecutiveDeadRefreshes": state["consecutiveDeadRefreshes"],
                }

                if status in {"not_found", "private"}:
                    summary["dead"] += 1
                    if quarantine_profile(args.out, artist_id):
                        summary["quarantined"] += 1
                    action = "quarantined-dead"
                    append_audit_once(
                        args.audit_log,
                        {**audit, "action": action},
                        event_id=f"{sweep_id}:{handle}:{status}:{action}",
                    )
                elif status != "active" or row is None:
                    summary["transient"] += 1
                    action = "preserved-transient"
                    append_audit_once(
                        args.audit_log,
                        {**audit, "action": action},
                        event_id=f"{sweep_id}:{handle}:{status}:{action}",
                    )
                else:
                    audit.update(
                        {
                            "looksBookable": verdict,
                            "filterReason": filter_reason,
                        }
                    )
                    if not verdict and not args.no_filter:
                        summary["rejected"] += 1
                        if quarantine_profile(args.out, artist_id):
                            summary["quarantined"] += 1
                        action = "quarantined-filter"
                        append_audit_once(
                            args.audit_log,
                            {**audit, "action": action},
                            event_id=f"{sweep_id}:{handle}:{status}:{action}",
                        )
                    else:
                        record = make_profile_record(
                            artist_id=artist_id,
                            handle=handle,
                            row=row,
                            verdict=bool(verdict),
                            filter_reason=str(filter_reason),
                            filter_bypassed=bool(not verdict and args.no_filter),
                            refreshed_at=checked_at,
                        )
                        write_json_atomic(args.out / f"{artist_id}.json", record)
                        action = "written-bypass" if not verdict else "written"
                        append_audit_once(
                            args.audit_log,
                            {**audit, "action": action},
                            event_id=f"{sweep_id}:{handle}:{status}:{action}",
                        )
                        summary["written"] += 1
                        if record["images"]:
                            summary["withImages"] += 1

                # The ledger is written only after every downstream effect in
                # this locked transaction succeeds. A crash leaves the sweep
                # retryable; profile/quarantine writes are idempotent and
                # audit events are deduplicated by eventId.
                state["lastEffectsSweepId"] = sweep_id
                state["lastEffectsStatus"] = selected_status
                state["lastEffectsAction"] = action
                ledger_handles[handle] = state
            ledger.update(
                {
                    "version": 1,
                    "deadThreshold": args.dead_threshold,
                    "lastRunAt": checked_at,
                    "handles": ledger_handles,
                }
            )
            return ledger

        ledger = update_json_locked(
            args.status_ledger,
            {"version": 1, "deadThreshold": args.dead_threshold, "handles": {}},
            merge_ledger,
        )

        print(
            f"chunk {offset // args.chunk + 1}: status={actor_status} "
            f"rows={len(items)} cumulative={summary}"
        )
        update_json_locked(
            args.run_report,
            {},
            lambda current: merge_run_report(
                current,
                sweep_id=sweep_id,
                checked_at=checked_at,
                run_slice=run_slice,
                summary=summary,
                actor_runs=actor_runs.values(),
            ),
        )

    update_json_locked(
        args.run_report,
        {},
        lambda current: merge_run_report(
            current,
            sweep_id=sweep_id,
            checked_at=checked_at,
            run_slice=run_slice,
            summary=summary,
            actor_runs=actor_runs.values(),
        ),
    )
    stale_count = sum(1 for state in ledger["handles"].values() if state.get("stale"))
    print(f"DONE summary={summary} stale-in-ledger={stale_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
