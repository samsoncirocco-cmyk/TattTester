#!/usr/bin/env python3
"""Find US tattoo artists from public pages, without Apify.

Writes the same candidates.json + profiles.json that
scripts/import-discovery-to-neo4j.mjs already imports. Dry-run by default:
network commands do nothing until --execute.

What this will not do: log in, store cookies, solve a bot challenge, or
call Instagram's private ajax endpoints. Profile and following URLs on a
logged-out browser redirect to /accounts/login, and Instagram's robots.txt
disallows a generic crawler, so those hosts are skipped unless
--allow-disallowed-hosts names them. Even then a login wall stops the host.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from execution.discover_ig import load_required_queue
from execution.inhouse_fetch import (
    DEFAULT_DELAY_S,
    DEFAULT_MAX_REQUESTS,
    PoliteFetcher,
    urllib_transport,
)
from execution.inhouse_parse import (
    apply_bookability,
    assemble_candidates,
    duckduckgo_search_url,
    equivalent_apify_usd,
    mentions_from_bio,
    parse_instagram_document,
    parse_search_html,
    parse_shop_html,
    search_query,
    style_harvest_document,
)


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data" / "discovery" / "inhouse"
BLOCKED = {"challenge", "login-wall", "rate-limited", "robots-disallow", "robots-unknown"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return fallback


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def repo_root() -> Path:
    return ROOT


def extract_style_evidence(bios: list[str]) -> list[list[dict[str, Any]]]:
    """Call the canonical bio extractor. One process for the whole batch."""
    if not bios:
        return []
    script = r"""
import { extractStyleEvidence, rejectSpuriousEvidence } from "./scripts/lib/artist-styles.mjs";
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const bios = JSON.parse(raw);
const out = bios.map((bio) => {
  const text = String(bio ?? "");
  const hits = extractStyleEvidence(text);
  return rejectSpuriousEvidence(text, hits).kept;
});
process.stdout.write(JSON.stringify(out));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(bios),
        text=True,
        capture_output=True,
        cwd=repo_root(),
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "style extraction failed: " + (completed.stderr or completed.stdout)[-500:]
        )
    parsed = json.loads(completed.stdout or "[]")
    if not isinstance(parsed, list) or len(parsed) != len(bios):
        raise RuntimeError("style extraction returned an unexpected payload")
    return parsed


def make_fetcher(args) -> PoliteFetcher:
    allowed = frozenset(host.strip().lower() for host in (args.allow_disallowed_hosts or []) if host.strip())
    return PoliteFetcher(
        transport=urllib_transport,
        delay_s=args.delay_seconds,
        max_requests=args.max_requests,
        allow_disallowed_hosts=allowed,
    )


def load_reference(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict):
        raise RuntimeError("--reference must be a JSON object with an artists array")
    return payload


def parse_metros(raw_metros: list[str]) -> list[tuple[str, str]]:
    metros = []
    for raw in raw_metros:
        if "," not in raw:
            raise RuntimeError(f"--metro must be City,ST (got {raw!r})")
        city, state = raw.split(",", 1)
        city, state = city.strip(), state.strip().upper()
        if not city or len(state) != 2:
            raise RuntimeError(f"--metro must be City,ST (got {raw!r})")
        metros.append((city, state))
    return metros


def collect_search(args, queue, fetcher: PoliteFetcher | None) -> dict[str, Any]:
    path = args.out / "raw_search.json"
    raw = load_json(path, {})
    if not isinstance(raw, dict):
        raise RuntimeError("raw_search.json must be an object")
    metros = parse_metros(args.metro or [])
    if args.html_file:
        if len(metros) != 1:
            raise RuntimeError("--html-file requires exactly one --metro")
        city, state = metros[0]
        query = search_query(city, state)
        parsed = parse_search_html(Path(args.html_file).read_text())
        raw[query] = {
            "city": city,
            "state": state,
            "fetchStatus": parsed["fetchStatus"],
            "handles": parsed["handles"],
            "source": "html-file",
            "fetchedAt": utc_now(),
        }
        save_json(path, raw)
        print(f"[search] {city}, {state}: {parsed['fetchStatus']} handles={len(parsed['handles'])} (from file)")
        return raw

    if not metros:
        raise RuntimeError("collect-search needs at least one --metro City,ST")
    if fetcher is None:
        _print_dry_run("collect-search", [duckduckgo_search_url(search_query(c, s)) for c, s in metros])
        return raw

    for city, state in metros:
        query = search_query(city, state)
        cached = raw.get(query) if isinstance(raw.get(query), dict) else None
        if cached and cached.get("fetchStatus") == "results":
            print(f"[search] {city}, {state}: cached ({len(cached.get('handles') or [])})")
            continue
        if cached and cached.get("fetchStatus") in BLOCKED and not args.retry_blocked:
            print(f"[search] {city}, {state}: cached {cached.get('fetchStatus')} (pass --retry-blocked to try again)")
            continue
        outcome = fetcher.fetch(duckduckgo_search_url(query))
        if outcome.fetch_status != "ok":
            raw[query] = {
                "city": city,
                "state": state,
                "fetchStatus": outcome.fetch_status,
                "handles": [],
                "fetchedAt": utc_now(),
            }
            save_json(path, raw)
            print(f"[search] {city}, {state}: {outcome.fetch_status}")
            if outcome.fetch_status in {"challenge", "rate-limited", "robots-disallow"}:
                break
            continue
        parsed = parse_search_html(outcome.body)
        raw[query] = {
            "city": city,
            "state": state,
            "fetchStatus": parsed["fetchStatus"],
            "handles": parsed["handles"],
            "fetchedAt": utc_now(),
        }
        save_json(path, raw)
        print(f"[search] {city}, {state}: {parsed['fetchStatus']} handles={len(parsed['handles'])}")
        if parsed["fetchStatus"] == "challenge":
            break
    return raw


def collect_hashtags(args, fetcher: PoliteFetcher | None) -> dict[str, Any]:
    path = args.out / "raw_hashtags.json"
    raw = load_json(path, {})
    tags = [tag.lstrip("#").strip().lower() for tag in (args.tags or "").split(",") if tag.strip()]
    if not tags:
        raise RuntimeError("--tags is required")
    urls = [f"https://www.instagram.com/popular/{tag}/" for tag in tags]
    if fetcher is None:
        _print_dry_run("collect-hashtags", urls)
        return raw
    for tag, url in zip(tags, urls):
        if tag in raw and raw[tag].get("fetchStatus") in {"results", *BLOCKED, "shell"} and not args.retry_blocked:
            print(f"[hashtag] #{tag}: cached {raw[tag].get('fetchStatus')}")
            continue
        outcome = fetcher.fetch(url)
        handles: list[str] = []
        status = outcome.fetch_status
        if outcome.fetch_status == "ok":
            parsed = parse_instagram_document(outcome.body, outcome.final_url, outcome.status)
            status = parsed["fetchStatus"] if parsed["fetchStatus"] != "ok" else "results"
            handles = parsed.get("linkedHandles") or []
            if parsed["fetchStatus"] == "shell":
                status = "shell"
                handles = []
        raw[tag] = {"fetchStatus": status, "handles": handles, "fetchedAt": utc_now(), "finalUrl": outcome.final_url}
        save_json(path, raw)
        print(f"[hashtag] #{tag}: {status} handles={len(handles)}")
        if status in {"login-wall", "rate-limited", "robots-disallow", "challenge"}:
            break
    return raw


def collect_sites(args, fetcher: PoliteFetcher | None) -> dict[str, Any]:
    path = args.out / "raw_sites.json"
    raw = load_json(path, {})
    if args.html_file:
        shop = {
            "shopName": args.shop_name or "",
            "city": args.city or "",
            "state": (args.state or "").upper(),
            "url": args.page_url or f"file://{args.html_file}",
        }
        parsed = parse_shop_html(Path(args.html_file).read_text(), shop["url"], shop)
        parsed["fetchStatus"] = "ok"
        raw[shop["url"]] = parsed
        save_json(path, raw)
        print(f"[site] {shop['url']}: artists={len(parsed['artists'])} platform={parsed['platform']}")
        return raw

    sites = _load_sites(args.sites)
    if fetcher is None:
        _print_dry_run("collect-sites", [row["url"] for row in sites])
        return raw
    for row in sites:
        url = row["url"]
        cached = raw.get(url) if isinstance(raw.get(url), dict) else None
        if cached and cached.get("fetchStatus") == "ok" and not args.retry_blocked:
            print(f"[site] {url}: cached ({len(cached.get('artists') or [])})")
            continue
        outcome = fetcher.fetch(url)
        if outcome.fetch_status != "ok":
            raw[url] = {**row, "fetchStatus": outcome.fetch_status, "artists": [], "fetchedAt": utc_now()}
            save_json(path, raw)
            print(f"[site] {url}: {outcome.fetch_status}")
            continue
        parsed = parse_shop_html(outcome.body, outcome.final_url or url, row)
        parsed["fetchStatus"] = "ok"
        parsed["fetchedAt"] = utc_now()
        raw[url] = parsed
        save_json(path, raw)
        print(f"[site] {url}: artists={len(parsed['artists'])} platform={parsed['platform']}")
    return raw


def _load_sites(path: Path | None) -> list[dict[str, Any]]:
    if path is None:
        raise RuntimeError("collect-sites needs --sites or --html-file")
    payload = json.loads(Path(path).read_text())
    if not isinstance(payload, list) or not payload:
        raise RuntimeError("--sites must be a non-empty JSON array")
    rows = []
    for index, row in enumerate(payload):
        url = str(row.get("url") or "").strip()
        if not url.startswith("http"):
            raise RuntimeError(f"--sites[{index}] needs an http(s) url")
        rows.append(
            {
                "url": url,
                "shopName": str(row.get("shopName") or row.get("name") or "").strip(),
                "city": str(row.get("city") or "").strip(),
                "state": str(row.get("state") or "").strip().upper(),
            }
        )
    return rows


def collect_mentions(args) -> dict[str, Any]:
    profiles = load_json(args.out / "profiles.json", {})
    if not isinstance(profiles, dict):
        raise RuntimeError("profiles.json must be an object")
    mentions: dict[str, list[str]] = {}
    for handle, profile in profiles.items():
        if not isinstance(profile, dict):
            continue
        found = [item for item in mentions_from_bio(profile.get("bio") or "") if item != handle]
        if found:
            mentions[handle] = found
    save_json(args.out / "raw_mentions.json", mentions)
    print(f"[mentions] seeds={len(mentions)} handles={sum(len(v) for v in mentions.values())}")
    return mentions


def enrich_profiles(args, fetcher: PoliteFetcher | None) -> None:
    assembled = _assemble(args)
    profiles = assembled["profiles"]
    todo = [
        candidate["handle"]
        for candidate in assembled["candidates"]
        if (profiles.get(candidate["handle"]) or {}).get("fetchStatus") != "ok"
        or (profiles.get(candidate["handle"]) or {}).get("origin") == "site"
    ]
    # Site rows are already useful. Re-fetching them needs an explicit Instagram allow,
    # otherwise the first login wall would end the run.
    if "instagram.com" not in {host.lower().removeprefix("www.") for host in (args.allow_disallowed_hosts or [])}:
        todo = [
            handle for handle in todo
            if (profiles.get(handle) or {}).get("origin") != "site"
        ]
    todo = todo[: args.max]
    urls = [f"https://www.instagram.com/{handle}/" for handle in todo]
    allowed = {host.lower().removeprefix("www.") for host in (args.allow_disallowed_hosts or [])}
    if "instagram.com" not in allowed:
        print(
            "Instagram profile fetches stay off until --allow-disallowed-hosts instagram.com. "
            f"{len(todo)} handle(s) are waiting. A login wall still stops the host after that."
        )
        return
    if fetcher is None:
        _print_dry_run("enrich", urls[:20], extra=f"would fetch {len(urls)} profile(s)")
        return
    for handle, url in zip(todo, urls):
        outcome = fetcher.fetch(url)
        if outcome.fetch_status == "ok":
            parsed = parse_instagram_document(outcome.body, outcome.final_url, outcome.status)
        else:
            parsed = {"fetchStatus": outcome.fetch_status, "bio": "", "fullName": "", "followers": None,
                      "url": "", "private": False, "postCount": None}
        _remember(profiles, handle, parsed)
        save_json(args.out / "profiles.json", profiles)
        print(f"[profile] @{handle}: {profiles[handle].get('enrichStatus') or profiles[handle].get('fetchStatus')}")
        if outcome.fetch_status in {"login-wall", "rate-limited", "robots-disallow", "challenge"}:
            break


def _remember(profiles: dict[str, Any], handle: str, parsed: dict[str, Any]) -> None:
    current = profiles.get(handle) if isinstance(profiles.get(handle), dict) else None
    if parsed.get("fetchStatus") == "ok":
        kept = {key: value for key, value in parsed.items() if key != "linkedHandles"}
        profiles[handle] = {**kept, "origin": "instagram"}
        return
    if current and current.get("fetchStatus") == "ok":
        current["enrichStatus"] = parsed.get("fetchStatus")
        profiles[handle] = current
        return
    profiles[handle] = parsed


def enrich_contacts(args, fetcher: PoliteFetcher | None) -> None:
    profiles = load_json(args.out / "profiles.json", {})
    if not isinstance(profiles, dict):
        raise RuntimeError("profiles.json must be an object; run a collect step first")
    todo = []
    for handle, profile in profiles.items():
        if not isinstance(profile, dict):
            continue
        url = str(profile.get("url") or "").strip()
        if url.startswith("http") and "instagram.com" not in url.lower() and not profile.get("contactFetchedAt"):
            todo.append((handle, url))
    todo = todo[: args.max]
    if fetcher is None:
        _print_dry_run("enrich-contacts", [url for _, url in todo[:20]], extra=f"would fetch {len(todo)} page(s)")
        return
    for handle, url in todo:
        outcome = fetcher.fetch(url)
        profile = profiles[handle]
        if outcome.fetch_status == "ok":
            parsed = parse_shop_html(outcome.body, outcome.final_url or url, {})
            profile["emails"] = parsed["emails"]
            profile["phones"] = parsed["phones"]
            profile["platform"] = parsed["platform"]
            profile["bookingUrls"] = parsed["bookingUrls"]
            if parsed["bookingUrls"] and not profile.get("url"):
                profile["url"] = parsed["bookingUrls"][0]
        profile["contactStatus"] = outcome.fetch_status
        profile["contactFetchedAt"] = utc_now()
        profiles[handle] = profile
        save_json(args.out / "profiles.json", profiles)
        print(f"[contact] @{handle}: {outcome.fetch_status} platform={profile.get('platform')}")


def filter_candidates(args, queue) -> dict[str, Any]:
    assembled = _assemble(args, queue)
    profiles = assembled["profiles"]
    reviewed = apply_bookability(assembled["candidates"], profiles)
    bios = [(profiles.get(row["handle"]) or {}).get("bio") or "" for row in reviewed]
    evidence = extract_style_evidence(bios)
    evidence_by_handle = {}
    for row, hits in zip(reviewed, evidence):
        evidence_by_handle[row["handle"]] = hits
        row["styles"] = [hit.get("style") for hit in hits if hit.get("style")]
    generated = utc_now()
    save_json(args.out / "candidates.json", reviewed)
    save_json(args.out / "profiles.json", profiles)
    save_json(
        args.out / "style-harvest.json",
        style_harvest_document(profiles, evidence_by_handle, generated),
    )
    save_json(args.out / "dedupe-report.json", assembled["skipped"])
    accepted = sum(1 for row in reviewed if row["looksBookable"])
    print(
        f"reviewed={len(reviewed)} accepted={accepted} "
        f"skipped_known={assembled['skipped']['known']} "
        f"skipped_protected={assembled['skipped']['protected']}"
    )
    print(f"written -> {args.out / 'candidates.json'}")
    return assembled


def _assemble(args, queue=None) -> dict[str, Any]:
    if queue is None:
        queue = load_required_queue(args.queue)
    search_rows = load_json(args.out / "raw_search.json", {})
    site_rows = load_json(args.out / "raw_sites.json", {})
    mention_rows = load_json(args.out / "raw_mentions.json", {})
    hashtag_rows = load_json(args.out / "raw_hashtags.json", {})
    profiles = load_json(args.out / "profiles.json", {})
    # Hashtag shells land in the same shape as search rows so one assembler
    # dedupes both.
    for tag, row in (hashtag_rows or {}).items():
        if isinstance(row, dict) and row.get("fetchStatus") == "results":
            search_rows[f"#{tag}"] = {
                "fetchStatus": "results",
                "handles": row.get("handles") or [],
                "city": "",
                "state": "",
            }
    return assemble_candidates(
        queue=queue,
        reference=load_reference(args.reference),
        search_rows=search_rows if isinstance(search_rows, dict) else {},
        site_rows=site_rows if isinstance(site_rows, dict) else {},
        mention_rows=mention_rows if isinstance(mention_rows, dict) else {},
        profiles=profiles if isinstance(profiles, dict) else {},
    )


def show_stats(args, queue) -> None:
    assembled = _assemble(args, queue)
    reviewed = apply_bookability(assembled["candidates"], assembled["profiles"])
    accepted = sum(1 for row in reviewed if row["looksBookable"])
    print(f"new handles: {len(reviewed)}")
    print(f"looksBookable: {accepted}")
    print(f"skipped known: {assembled['skipped']['known']}")
    print(f"skipped protected: {assembled['skipped']['protected']} {assembled['skipped']['protectedReasons']}")


def show_plan(args) -> None:
    metros = parse_metros(args.metro or [])
    sites = []
    if args.sites:
        sites = _load_sites(args.sites)
    search_urls = [duckduckgo_search_url(search_query(city, state)) for city, state in metros]
    site_urls = [row["url"] for row in sites]
    allowed = sorted({host.lower() for host in (args.allow_disallowed_hosts or [])})
    cost = equivalent_apify_usd(
        search_pages=len(search_urls),
        contact_pages=len(site_urls),
        fetched_pages=len(site_urls),
        tech_results=len(site_urls),
    )
    print("DRY RUN plan — no requests were sent.")
    print(f"  search pages: {len(search_urls)}")
    print(f"  shop pages:   {len(site_urls)}")
    print(f"  delay:        {args.delay_seconds}s between requests")
    print(f"  cap:          {args.max_requests} requests this process")
    print(f"  instagram/google allowed hosts: {allowed or 'none'}")
    print(f"  avoided Apify starting price for this plan: ${cost['total']:.4f}")
    for url in (search_urls + site_urls)[:15]:
        print(f"    {url}")


def _print_dry_run(command: str, urls: list[str], extra: str = "") -> None:
    print(f"DRY RUN: no requests for {command}. Pass --execute to fetch.")
    if extra:
        print(f"  {extra}")
    for url in urls[:15]:
        print(f"    {url}")
    if len(urls) > 15:
        print(f"    … {len(urls) - 15} more")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="In-house public artist discovery")
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--delay-seconds", type=float, default=DEFAULT_DELAY_S)
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--allow-disallowed-hosts", action="append", default=[])
    parser.add_argument("--retry-blocked", action="store_true")
    parser.add_argument("--metro", action="append", default=[], help="City,ST. Repeatable. Used by plan and collect-search.")
    parser.add_argument("--sites", type=Path, help="JSON array of {url, shopName, city, state}")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("plan")
    search = commands.add_parser("collect-search")
    search.add_argument("--html-file", type=Path)
    tags = commands.add_parser("collect-hashtags")
    tags.add_argument("--tags", required=True)
    sites = commands.add_parser("collect-sites")
    sites.add_argument("--html-file", type=Path)
    sites.add_argument("--page-url")
    sites.add_argument("--shop-name")
    sites.add_argument("--city")
    sites.add_argument("--state")
    commands.add_parser("collect-mentions")
    enrich = commands.add_parser("enrich")
    enrich.add_argument("--max", type=int, default=50)
    contacts = commands.add_parser("enrich-contacts")
    contacts.add_argument("--max", type=int, default=50)
    commands.add_parser("filter")
    commands.add_parser("stats")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.delay_seconds < 0:
        parser.error("--delay-seconds must be >= 0")
    if args.max_requests < 1:
        parser.error("--max-requests must be >= 1")
    queue = load_required_queue(args.queue)
    offline = {"plan", "collect-mentions", "filter", "stats"}
    html_offline = args.command in {"collect-search", "collect-sites"} and args.html_file
    fetcher = None
    if args.command not in offline and not html_offline:
        if not args.execute:
            if args.command == "plan":
                pass
            elif args.command == "collect-search":
                collect_search(args, queue, None)
                return 0
            elif args.command == "collect-hashtags":
                collect_hashtags(args, None)
                return 0
            elif args.command == "collect-sites":
                collect_sites(args, None)
                return 0
            elif args.command == "enrich":
                enrich_profiles(args, None)
                return 0
            elif args.command == "enrich-contacts":
                enrich_contacts(args, None)
                return 0
        else:
            fetcher = make_fetcher(args)

    if args.command == "plan":
        show_plan(args)
    elif args.command == "collect-search":
        collect_search(args, queue, fetcher)
    elif args.command == "collect-hashtags":
        collect_hashtags(args, fetcher)
    elif args.command == "collect-sites":
        collect_sites(args, fetcher)
    elif args.command == "collect-mentions":
        collect_mentions(args)
    elif args.command == "enrich":
        enrich_profiles(args, fetcher)
    elif args.command == "enrich-contacts":
        enrich_contacts(args, fetcher)
    elif args.command == "filter":
        filter_candidates(args, queue)
    else:
        show_stats(args, queue)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
