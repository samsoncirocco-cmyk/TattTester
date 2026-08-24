#!/usr/bin/env python3
"""Instagram artist DISCOVERY for the TatT project (find NEW handles).

Distinct from enrichment (which scrapes profiles for artists we already have).
This finds candidate NEW tattoo-artist handles via two strategies, dedupes them
against the existing artist set, profile-scrapes survivors, and applies a
bio-based quality filter to flag likely-bookable artists.

  Strategy A  followee expansion : scrape who a seed (shop/artist) FOLLOWS
                                    -> peers + shop artists. High signal.
  Strategy B  hashtag / location  : scrape recent posters of city tattoo tags
                                    -> post authors. High volume, more noise.

Nothing here writes to Neo4j or the app. Output is a review file only:
  data/discovery/candidates.json = [{handle, source, seedFrom, bioSnippet,
                                     followers, looksBookable}]

Usage:
  discover_ig.py collectA --seeds a,b,c --max 100      # followee expansion
  discover_ig.py collectB --tags austintattoo,... --limit 40
  discover_ig.py enrich --max 200                      # profile-scrape raw candidates
  discover_ig.py filter                                # dedup + quality filter -> candidates.json
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.parse

TOKEN = os.environ.get("APIFY_TOKEN") or open("/opt/org/.env").read().split("APIFY_TOKEN=")[1].split("\n")[0].strip()
BASE = "https://api.apify.com/v2"
FOLLOW_ACTOR  = "coderx~instagram-followers-following-scraper-no-cookies-login"
HASHTAG_ACTOR = "apify~instagram-hashtag-scraper"
PROFILE_ACTOR = "apify~instagram-profile-scraper"

ROOT = os.path.expanduser("~/tatt-scraper")
QUEUE = f"{ROOT}/data/enrichment/instagram/artist-queue.json"
OUT   = f"{ROOT}/data/discovery"
RAW_A = f"{OUT}/raw_followees.json"     # {seed: [handles]}
RAW_B = f"{OUT}/raw_hashtags.json"      # {tag: [handles]}
PROFILES = f"{OUT}/profiles.json"        # {handle: profile_row}
CANDIDATES = f"{OUT}/candidates.json"
os.makedirs(OUT, exist_ok=True)


def api(method, path, body=None, timeout=180):
    url = f"{BASE}{path}{'&' if '?' in path else '?'}token={TOKEN}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def run_actor(actor, inp, poll_max=180):
    run = api("POST", f"/acts/{actor}/runs", inp)["data"]
    rid, dsid = run["id"], run["defaultDatasetId"]
    st = run["status"]
    for _ in range(poll_max):
        st = api("GET", f"/actor-runs/{rid}")["data"]["status"]
        if st in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            break
        time.sleep(4)
    items = api("GET", f"/datasets/{dsid}/items?clean=true")
    return st, items


def load(p, default): return json.load(open(p)) if os.path.exists(p) else default
def save(p, o): json.dump(o, open(p, "w"), indent=1)


def existing_handles():
    q = json.load(open(QUEUE))
    return {str(a.get("ig", "")).lstrip("@").strip().lower() for a in q if a.get("ig")}


# ---- collectors -----------------------------------------------------------
def collect_A(seeds, max_items):
    raw = load(RAW_A, {})
    for seed in seeds:
        seed = seed.lstrip("@").strip().lower()
        if seed in raw:
            print(f"[A] {seed}: cached ({len(raw[seed])})"); continue
        try:
            st, items = run_actor(FOLLOW_ACTOR,
                                  {"username": seed, "scrape_type": "following", "max_items": max_items})
        except Exception as e:
            print(f"[A] {seed}: ERROR {e}"); continue
        handles = []
        for it in items:
            h = (it.get("username") or it.get("handle") or it.get("user_name") or "").lstrip("@").lower()
            if h: handles.append(h)
        raw[seed] = sorted(set(handles))
        save(RAW_A, raw)
        print(f"[A] {seed}: status={st} following_scraped={len(items)} unique={len(raw[seed])}")
    return raw


def collect_B(tags, limit):
    raw = load(RAW_B, {})
    for tag in tags:
        tag = tag.lstrip("#").strip().lower()
        if tag in raw:
            print(f"[B] #{tag}: cached ({len(raw[tag])})"); continue
        try:
            st, items = run_actor(HASHTAG_ACTOR, {"hashtags": [tag], "resultsLimit": limit})
        except Exception as e:
            print(f"[B] #{tag}: ERROR {e}"); continue
        handles, posts = [], 0
        for it in items:
            posts += 1
            h = (it.get("ownerUsername") or it.get("owner_username") or "").lstrip("@").lower()
            if h: handles.append(h)
        raw[tag] = sorted(set(handles))
        save(RAW_B, raw)
        print(f"[B] #{tag}: status={st} posts={posts} unique_authors={len(raw[tag])}")
    return raw


def all_raw_candidates():
    """Return {handle: {sources:set, seedFrom:set}} across A and B, dedup vs existing."""
    ex = existing_handles()
    cand = {}
    for seed, hs in load(RAW_A, {}).items():
        for h in hs:
            if h in ex or h == seed: continue
            c = cand.setdefault(h, {"sources": set(), "seedFrom": set()})
            c["sources"].add("A:followee"); c["seedFrom"].add(seed)
    for tag, hs in load(RAW_B, {}).items():
        for h in hs:
            if h in ex: continue
            c = cand.setdefault(h, {"sources": set(), "seedFrom": set()})
            c["sources"].add("B:hashtag"); c["seedFrom"].add(f"#{tag}")
    return cand, ex


def enrich(max_profiles):
    cand, _ = all_raw_candidates()
    prof = load(PROFILES, {})
    todo = [h for h in cand if h not in prof][:max_profiles]
    print(f"candidates(new,deduped)={len(cand)} already_profiled={len(prof)} scraping={len(todo)}")
    for i in range(0, len(todo), 50):
        chunk = todo[i:i + 50]
        st, items = run_actor(PROFILE_ACTOR, {"usernames": chunk})
        for row in items:
            u = (row.get("username") or "").lower()
            if u:
                prof[u] = {
                    "bio": row.get("biography") or "",
                    "followers": row.get("followersCount"),
                    "fullName": row.get("fullName") or "",
                    "url": row.get("externalUrl") or "",
                    "category": row.get("businessCategoryName") or row.get("category") or "",
                    "private": row.get("private"),
                    "verified": row.get("verified"),
                }
        save(PROFILES, prof)
        print(f"  profiled chunk {i//50+1} status={st} rows={len(items)} total={len(prof)}")


# ---- quality filter -------------------------------------------------------
TATTOO_DOER = re.compile(r"tattoo(er|ist|ing)?\b|tattoo\s*artist|tatuador|t[a�]towier|ink slinger|blackwork|fineline|fine line|realism|traditional tattoo|apprentice", re.I)
BOOK = re.compile(r"book(ing|s)?\b|appt|appointment|dm to book|walk[- ]?in|books?\s*(open|closed)|flash|guest ?spot|resident|inquir|deposit|slots?\b", re.I)
PIERCE = re.compile(r"pierc", re.I)
# supply / equipment / ink brands (usually big follower brand accounts, not bookable people)
SUPPLY = re.compile(r"\b(supply|supplies|cartridge|needles?|ointment|wholesale|distributor|worldwide shipping|shop now|our products?|pigment|machines? for|equipment|official (page|account|store)|®|™)\b", re.I)
BRAND_NAMES = re.compile(r"\b(electric ?ink|dragonhawk|eternal ?ink|cheyenne|bishop|critical|fusion ink|world famous|villain ?arts|inkjecta|kwadron|dynamic color|stigma)\b", re.I)
CONVENTION = re.compile(r"convention|expo\b|invitational|tattoo ?fest|festival|tickets? (on|now)|book your booth", re.I)
# multi-artist SHOP accounts (not an individual bookable artist)
SHOP_ACCT = re.compile(r"our (artists|team)|resident artists|guest artists|artists:|now hiring|hiring artists|book (with|your artist)|walk[- ]?ins welcome|tattoo (studio|shop|parlou?r|collective) (in|located|est)|@\w+ ?(&|and) ?@\w+", re.I)


def looks_bookable(prof):
    bio = (prof.get("bio") or "")
    name = (prof.get("fullName") or "")
    txt = f"{bio} {name}"
    low = txt.lower()
    fol = prof.get("followers") or 0
    if prof.get("private"): return False, "private"
    is_tattooer = bool(TATTOO_DOER.search(txt)) or "tattoo" in low
    if not is_tattooer: return False, "no-tattoo-signal"
    if PIERCE.search(txt) and not TATTOO_DOER.search(txt) and "tattoo" not in low:
        return False, "piercer-only"
    if BRAND_NAMES.search(txt) or SUPPLY.search(txt): return False, "supply/brand"
    if CONVENTION.search(txt): return False, "convention/event"
    # brand-account heuristic: very large account pushing products, not a person
    if fol > 60000 and (SUPPLY.search(txt) or "official" in low or "products" in low):
        return False, "brand-account"
    if SHOP_ACCT.search(txt): return False, "shop-account"
    has_person = bool(TATTOO_DOER.search(txt))          # names a tattoo-doing craft
    has_book = bool(BOOK.search(txt))
    has_link = bool(prof.get("url"))
    if has_person and (has_book or has_link):
        return True, "artist+booking"
    if has_book or has_link:
        return True, "bookable-signal"
    return True, "tattoo-artist(weak)"


def do_filter():
    cand, ex = all_raw_candidates()
    prof = load(PROFILES, {})
    out = []
    for h, meta in cand.items():
        p = prof.get(h)
        if not p:
            continue  # only emit candidates we could profile+judge
        ok, reason = looks_bookable(p)
        bio = (p.get("bio") or "").replace("\n", " ").strip()
        out.append({
            "handle": h,
            "source": ",".join(sorted(meta["sources"])),
            "seedFrom": ",".join(sorted(meta["seedFrom"])),
            "bioSnippet": bio[:160],
            "followers": p.get("followers"),
            "looksBookable": ok,
            "filterReason": reason,
        })
    out.sort(key=lambda x: (not x["looksBookable"], -(x["followers"] or 0)))
    save(CANDIDATES, out)
    good = sum(1 for x in out if x["looksBookable"])
    print(f"\n=== FILTER RESULT ===")
    print(f"deduped-new candidates with a profile: {len(out)}")
    print(f"  looksBookable=TRUE : {good}")
    print(f"  looksBookable=FALSE: {len(out)-good}")
    from collections import Counter
    print("  reasons:", dict(Counter(x["filterReason"] for x in out)))
    # per-source breakdown
    for src in ("A:followee", "B:hashtag"):
        sub = [x for x in out if src in x["source"]]
        g = sum(1 for x in sub if x["looksBookable"])
        print(f"  [{src}] profiled={len(sub)} bookable={g}")
    print(f"written -> {CANDIDATES}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("collectA"); a.add_argument("--seeds", required=True); a.add_argument("--max", type=int, default=100)
    b = sub.add_parser("collectB"); b.add_argument("--tags", required=True); b.add_argument("--limit", type=int, default=40)
    e = sub.add_parser("enrich"); e.add_argument("--max", type=int, default=200)
    sub.add_parser("filter")
    sub.add_parser("stats")
    args = ap.parse_args()
    if args.cmd == "collectA": collect_A(args.seeds.split(","), args.max)
    elif args.cmd == "collectB": collect_B(args.tags.split(","), args.limit)
    elif args.cmd == "enrich": enrich(args.max)
    elif args.cmd == "filter": do_filter()
    elif args.cmd == "stats":
        cand, ex = all_raw_candidates()
        print("raw deduped-new candidate handles:", len(cand))


if __name__ == "__main__":
    main()
