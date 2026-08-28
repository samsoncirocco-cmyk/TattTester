#!/usr/bin/env python3
"""Find and review new Instagram artist handles without writing to the graph.

Discovery and enrichment share ``execution.ig_quality.looks_bookable`` so a
verdict cannot be computed under one set of rules and imported under another.
All candidates, including rejected ones, remain in the review artifact.

The profile row carries ``postCount`` because the graph importer
(``scripts/import-discovery-to-neo4j.mjs``) gates candidates on having photos
and cannot evaluate that gate without it — the first discovery pilot planned a
yield of zero for exactly this reason (#364).  ``None`` means never scraped and
is held by the importer; ``0`` means a genuinely empty profile and is
rejected, so the two are kept distinct everywhere.  Profiles cached before this
field existed are repaired by ``enrich-candidates --backfill``.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

try:
    from execution.apify_ig_enrich import merge_run_report, update_json_locked
    from execution.ig_quality import looks_bookable
except ModuleNotFoundError:  # direct ``python execution/discover_ig.py``
    from apify_ig_enrich import merge_run_report, update_json_locked
    from ig_quality import looks_bookable


BASE = "https://api.apify.com/v2"
FOLLOW_ACTOR = "coderx~instagram-followers-following-scraper-no-cookies-login"
HASHTAG_ACTOR = "apify~instagram-hashtag-scraper"
PROFILE_ACTOR = "apify~instagram-profile-scraper"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "discovery"
TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_token() -> str:
    token = os.environ.get("APIFY_TOKEN", "").strip()
    if token:
        return token
    raise RuntimeError("APIFY_TOKEN is required")


def load(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def save(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def load_required_queue(queue_path: Path) -> list[dict[str, Any]]:
    if not queue_path.is_file():
        raise RuntimeError(f"artist queue does not exist: {queue_path}")
    try:
        queue = json.loads(queue_path.read_text())
    except json.JSONDecodeError as error:
        raise RuntimeError(f"artist queue is not valid JSON: {queue_path}") from error
    if not isinstance(queue, list) or not queue:
        raise RuntimeError(f"artist queue must be a non-empty JSON array: {queue_path}")
    invalid = []
    artist_ids = set()
    handles = set()
    for index, artist in enumerate(queue):
        artist_id = str(artist.get("id") or "").strip() if isinstance(artist, dict) else ""
        handle = (
            str(artist.get("ig") or "").lstrip("@").strip().lower()
            if isinstance(artist, dict)
            else ""
        )
        if not artist_id or not handle or artist_id in artist_ids or handle in handles:
            invalid.append(index)
            continue
        artist_ids.add(artist_id)
        handles.add(handle)
    if invalid:
        raise RuntimeError(
            "artist queue has missing or duplicate id/ig records at indexes: "
            f"{invalid[:10]}"
        )
    return queue


def api(token: str, method: str, path: str, body: Any = None, timeout: int = 180) -> Any:
    url = f"{BASE}{path}"
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


def run_actor(
    token: str,
    actor: str,
    actor_input: dict[str, Any],
    *,
    checkpoint: Any,
    operation: str,
    poll_max: int = 180,
    attempt_id: str | None = None,
):
    attempt_id = attempt_id or uuid.uuid4().hex
    checked_at = utc_now()
    attempt = {
        "attemptId": attempt_id,
        "id": None,
        "actor": actor,
        "operation": operation,
        "status": "POSTING",
        "terminal": False,
        "usageTotalUsd": None,
        "startedAt": checked_at,
        "spendStatus": "ambiguous",
    }
    checkpoint(attempt)
    try:
        response = api(token, "POST", f"/acts/{actor}/runs", actor_input)
    except Exception as error:
        checkpoint({**attempt, "status": "POST_ERROR", "error": str(error)})
        raise

    run = dict(response.get("data") or {})
    run_id = run.get("id")
    dataset_id = run.get("defaultDatasetId")
    if not run_id or not dataset_id:
        checkpoint(
            {
                **attempt,
                **run,
                "status": "MALFORMED_POST_RESPONSE",
                "terminal": False,
                "spendStatus": "ambiguous",
            }
        )
        raise RuntimeError("Apify discovery POST returned no run or dataset ID")

    final = {
        **attempt,
        **run,
        "attemptId": attempt_id,
        "id": run_id,
        "terminal": str(run.get("status") or "") in TERMINAL_STATUSES,
        "spendStatus": "identified",
    }
    checkpoint(final)
    if not final["terminal"]:
        try:
            for _ in range(poll_max):
                polled = dict(api(token, "GET", f"/actor-runs/{run_id}")["data"])
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
                time.sleep(4)
            else:
                checkpoint(final)
        except Exception as error:
            checkpoint(
                {
                    **final,
                    "status": "POLL_ERROR",
                    "terminal": False,
                    "error": str(error),
                }
            )
            raise

    if final.get("status") != "SUCCEEDED":
        raise RuntimeError(
            f"Apify discovery actor did not succeed: {final.get('status') or 'UNKNOWN'}"
        )

    try:
        items = api(token, "GET", f"/datasets/{dataset_id}/items?clean=true")
    except Exception as error:
        checkpoint({**final, "dataError": str(error)})
        raise
    return "SUCCEEDED", items


def existing_handles(queue_path: Path) -> set[str]:
    queue = load_required_queue(queue_path)
    return {
        str(artist.get("ig", "")).lstrip("@").strip().lower()
        for artist in queue
        if artist.get("ig")
    }


def collect_followees(
    token: str,
    seeds: list[str],
    max_items: int,
    raw_path: Path,
    checkpoint: Any,
) -> dict[str, list[str]]:
    raw = load(raw_path, {})
    failures = []
    for original in seeds:
        seed = original.lstrip("@").strip().lower()
        if seed in raw:
            print(f"[followee] {seed}: cached ({len(raw[seed])})")
            continue
        try:
            status, items = run_actor(
                token,
                FOLLOW_ACTOR,
                {"username": seed, "scrape_type": "following", "max_items": max_items},
                checkpoint=checkpoint,
                operation=f"collect-followees:{seed}",
            )
        except Exception as error:
            print(f"[followee] {seed}: ERROR {error}")
            failures.append(seed)
            continue
        handles = {
            str(item.get("username") or item.get("handle") or item.get("user_name") or "")
            .lstrip("@")
            .lower()
            for item in items
        }
        raw[seed] = sorted(handle for handle in handles if handle)
        save(raw_path, raw)
        print(f"[followee] {seed}: status={status} unique={len(raw[seed])}")
    if failures:
        raise RuntimeError(
            "followee discovery failed and was not cached for: "
            + ", ".join(failures)
        )
    return raw


def collect_hashtags(
    token: str,
    tags: list[str],
    limit: int,
    raw_path: Path,
    checkpoint: Any,
) -> dict[str, list[str]]:
    raw = load(raw_path, {})
    failures = []
    for original in tags:
        tag = original.lstrip("#").strip().lower()
        if tag in raw:
            print(f"[hashtag] #{tag}: cached ({len(raw[tag])})")
            continue
        try:
            status, items = run_actor(
                token,
                HASHTAG_ACTOR,
                {"hashtags": [tag], "resultsLimit": limit},
                checkpoint=checkpoint,
                operation=f"collect-hashtags:{tag}",
            )
        except Exception as error:
            print(f"[hashtag] #{tag}: ERROR {error}")
            failures.append(tag)
            continue
        handles = {
            str(item.get("ownerUsername") or item.get("owner_username") or "")
            .lstrip("@")
            .lower()
            for item in items
        }
        raw[tag] = sorted(handle for handle in handles if handle)
        save(raw_path, raw)
        print(f"[hashtag] #{tag}: status={status} unique={len(raw[tag])}")
    if failures:
        raise RuntimeError(
            "hashtag discovery failed and was not cached for: "
            + ", ".join(failures)
        )
    return raw


def all_raw_candidates(
    queue_path: Path,
    raw_followees_path: Path,
    raw_hashtags_path: Path,
) -> dict[str, dict[str, set[str]]]:
    existing = existing_handles(queue_path)
    candidates: dict[str, dict[str, set[str]]] = {}
    raw_followees = load(raw_followees_path, {})
    raw_hashtags = load(raw_hashtags_path, {})
    if not isinstance(raw_followees, dict) or not isinstance(raw_hashtags, dict):
        raise RuntimeError("discovery input artifacts must be JSON objects")
    if not raw_followees and not raw_hashtags:
        raise RuntimeError(
            "no discovery input artifacts found; collect followees or hashtags first"
        )
    for seed, handles in raw_followees.items():
        for handle in handles:
            if handle in existing or handle == seed:
                continue
            item = candidates.setdefault(handle, {"sources": set(), "seedFrom": set()})
            item["sources"].add("followee")
            item["seedFrom"].add(seed)
    for tag, handles in raw_hashtags.items():
        for handle in handles:
            if handle in existing:
                continue
            item = candidates.setdefault(handle, {"sources": set(), "seedFrom": set()})
            item["sources"].add("hashtag")
            item["seedFrom"].add(f"#{tag}")
    return candidates


def profile_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Map one ``apify~instagram-profile-scraper`` item to the cached profile.

    ``postsCount`` is the actor's own spelling — the same field
    ``execution/apify_ig_enrich.py`` stores as ``posts``.  The alternates are
    tolerated because the actor's schema has drifted before, and losing this
    field silently is what produced a zero-yield pilot (#364).
    """

    posts = row.get("postsCount")
    if posts is None:
        posts = row.get("mediaCount")
    if posts is None:
        posts = row.get("postsCountValue")
    return {
        "bio": row.get("biography") or "",
        "followers": row.get("followersCount"),
        "fullName": row.get("fullName") or "",
        "url": row.get("externalUrl") or "",
        "category": row.get("businessCategoryName") or row.get("category") or "",
        "private": row.get("private"),
        "verified": row.get("verified"),
        "postCount": posts,
    }


def merge_profile(cached: Any, fresh: Mapping[str, Any]) -> dict[str, Any]:
    """Fold a fresh scrape into a cached profile without losing what we had.

    A re-scrape is not always an improvement: the actor returns a sparse row
    for accounts that have gone private, been renamed or been deleted since
    the original run, and a blind overwrite turns a profile we knew things
    about into an empty one.  Observed live during the #364 backfill — 8 of
    338 handles came back with every field stripped.

    Fresh values win whenever they carry information.  ``None`` and ``""`` do
    not count as information; ``0`` and ``False`` do, so a genuinely empty
    post count or a flipped ``private`` flag still lands.
    """

    if not isinstance(cached, Mapping):
        return dict(fresh)
    merged = dict(cached)
    for key, value in fresh.items():
        if value is None or value == "":
            merged.setdefault(key, value)
        else:
            merged[key] = value
    return merged


def missing_post_count(profiles: Mapping[str, Any]) -> list[str]:
    """Handles cached before ``postCount`` was captured, oldest problem first.

    These are indistinguishable from a fresh scrape in every other respect,
    which is why they have to be found by the absent field rather than by date.
    """

    return [
        handle
        for handle, profile in profiles.items()
        if (profile or {}).get("postCount") is None
    ]


def enrich_candidates(
    token: str,
    maximum: int,
    *,
    queue_path: Path,
    raw_followees_path: Path,
    raw_hashtags_path: Path,
    profiles_path: Path,
    checkpoint: Any,
    backfill: bool = False,
) -> None:
    candidates = all_raw_candidates(
        queue_path,
        raw_followees_path,
        raw_hashtags_path,
    )
    if not candidates:
        raise RuntimeError("no discovery candidates found in the selected input artifacts")
    profiles = load(profiles_path, {})
    if not isinstance(profiles, dict):
        raise RuntimeError("profile cache must be a JSON object")

    stale = missing_post_count(profiles)
    todo = [handle for handle in candidates if handle not in profiles]
    if backfill:
        # Repairing evidence already paid for outranks collecting more of it:
        # an unrepaired profile is held by the importer no matter how many new
        # candidates sit behind it.
        todo = stale + todo
    todo = todo[:maximum]
    if not todo:
        raise RuntimeError(
            "no uncached discovery candidates remain to enrich"
            if not stale or backfill
            else f"no uncached candidates remain, but {len(stale)} cached profiles "
            "predate postCount capture; re-run with --backfill to repair them"
        )
    print(
        f"candidates={len(candidates)} cached_profiles={len(profiles)} "
        f"missing_post_count={len(stale)} scraping={len(todo)}"
    )
    if stale and not backfill:
        print(
            f"NOTE: {len(stale)} cached profiles predate postCount capture and will be "
            "HELD by the importer's photo gate; --backfill re-scrapes exactly those"
        )
    for offset in range(0, len(todo), 50):
        chunk = todo[offset : offset + 50]
        status, items = run_actor(
            token,
            PROFILE_ACTOR,
            {"usernames": chunk},
            checkpoint=checkpoint,
            operation=f"enrich-candidates:{offset}:{len(chunk)}",
        )
        for row in items:
            username = str(row.get("username") or "").lower()
            if username:
                profiles[username] = merge_profile(profiles.get(username), profile_row(row))
        save(profiles_path, profiles)
        print(f"profile chunk={offset // 50 + 1} status={status} rows={len(items)}")
    print(f"missing_post_count_after={len(missing_post_count(profiles))}")


def filter_candidates(
    *,
    queue_path: Path,
    raw_followees_path: Path,
    raw_hashtags_path: Path,
    profiles_path: Path,
    candidates_path: Path,
) -> None:
    candidates = all_raw_candidates(
        queue_path,
        raw_followees_path,
        raw_hashtags_path,
    )
    profiles = load(profiles_path, {})
    if not isinstance(profiles, dict) or not profiles:
        raise RuntimeError("no profile input artifact found; run paid enrichment first")
    output = []
    for handle, metadata in candidates.items():
        profile = profiles.get(handle)
        if not profile:
            continue
        verdict, reason = looks_bookable(profile)
        bio = str(profile.get("bio") or "").replace("\n", " ").strip()
        output.append(
            {
                "handle": handle,
                "source": ",".join(sorted(metadata["sources"])),
                "seedFrom": ",".join(sorted(metadata["seedFrom"])),
                "bioSnippet": bio[:160],
                "followers": profile.get("followers"),
                # None = never scraped (importer holds), 0 = empty profile
                # (importer rejects). Never collapse the two.
                "postCount": profile.get("postCount"),
                "looksBookable": verdict,
                "filterReason": reason,
            }
        )
    output.sort(key=lambda item: (not item["looksBookable"], -(item["followers"] or 0)))
    if not output:
        raise RuntimeError("profile input contains none of the selected candidates")
    save(candidates_path, output)
    accepted = sum(1 for item in output if item["looksBookable"])
    unknown_photos = sum(
        1 for item in output if item["looksBookable"] and item["postCount"] is None
    )
    print(f"reviewed={len(output)} accepted={accepted} rejected={len(output) - accepted}")
    if unknown_photos:
        print(
            f"WARNING: {unknown_photos} of {accepted} accepted candidates have no postCount "
            "and will be held by the importer's photo gate; run "
            "enrich-candidates --backfill --execute before quoting a yield"
        )
    print("reasons:", dict(Counter(item["filterReason"] for item in output)))
    print(f"written -> {candidates_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--run-report", type=Path, default=None)
    parser.add_argument("--sweep-id", default=None)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="authorize paid Apify actor calls",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    followees = commands.add_parser("collect-followees")
    followees.add_argument("--seeds", required=True)
    followees.add_argument("--max", type=int, default=100)
    hashtags = commands.add_parser("collect-hashtags")
    hashtags.add_argument("--tags", required=True)
    hashtags.add_argument("--limit", type=int, default=40)
    enrich = commands.add_parser("enrich")
    enrich.add_argument("--max", type=int, default=200)
    enrich.add_argument(
        "--backfill",
        action="store_true",
        help="also re-scrape cached profiles that predate postCount capture (#364)",
    )
    commands.add_parser("filter")
    commands.add_parser("stats")
    args = parser.parse_args(argv)
    queue = load_required_queue(args.queue)
    raw_followees_path = args.out / "raw_followees.json"
    raw_hashtags_path = args.out / "raw_hashtags.json"
    profiles_path = args.out / "profiles.json"
    candidates_path = args.out / "candidates.json"

    if args.command == "filter":
        filter_candidates(
            queue_path=args.queue,
            raw_followees_path=raw_followees_path,
            raw_hashtags_path=raw_hashtags_path,
            profiles_path=profiles_path,
            candidates_path=candidates_path,
        )
        return 0
    if args.command == "stats":
        print(
            "raw deduped candidates:",
            len(
                all_raw_candidates(
                    args.queue,
                    raw_followees_path,
                    raw_hashtags_path,
                )
            ),
        )
        cached = load(profiles_path, {})
        if isinstance(cached, dict):
            print(
                f"cached profiles: {len(cached)} "
                f"missing postCount: {len(missing_post_count(cached))}"
            )
        return 0
    if not args.execute:
        print(
            f"DRY RUN: no paid actor calls; command={args.command} "
            f"queue={args.queue}. Pass --execute to run."
        )
        return 0
    if not args.sweep_id:
        parser.error("--sweep-id is required with --execute")

    token = load_token()
    run_report_path = args.run_report or args.out / "apify-discovery-run-report.json"

    def checkpoint_actor_run(record: dict[str, Any]) -> None:
        update_json_locked(
            run_report_path,
            {},
            lambda current: merge_run_report(
                current,
                sweep_id=args.sweep_id,
                checked_at=utc_now(),
                run_slice={
                    "command": args.command,
                    "queueRecords": len(queue),
                },
                summary={"command": args.command},
                actor_runs=[record],
            ),
        )

    if args.command == "collect-followees":
        collect_followees(
            token,
            args.seeds.split(","),
            args.max,
            raw_followees_path,
            checkpoint_actor_run,
        )
    elif args.command == "collect-hashtags":
        collect_hashtags(
            token,
            args.tags.split(","),
            args.limit,
            raw_hashtags_path,
            checkpoint_actor_run,
        )
    else:
        enrich_candidates(
            token,
            args.max,
            queue_path=args.queue,
            raw_followees_path=raw_followees_path,
            raw_hashtags_path=raw_hashtags_path,
            profiles_path=profiles_path,
            checkpoint=checkpoint_actor_run,
            backfill=args.backfill,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
