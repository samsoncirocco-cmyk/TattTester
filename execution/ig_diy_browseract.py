#!/usr/bin/env python3
"""DIY Instagram enrichment via a BrowserAct stealth browser session.

Recreates the Apify profile scraper for free: inside a stealth browser
parked on instagram.com, eval() a same-origin fetch() to the private
web_profile_info endpoint (with the x-ig-app-id header the endpoint
requires) — routed through BrowserAct's proxy + fingerprint. Returns the
same JSON Apify gives: bio, follower/post counts, 12 post-image CDN URLs.

Writes one file per artist into the hosting-pipeline INPUT dir, in the
shape scripts/host-artist-images.mjs consumes:
  { "artistId","handle","images":[...], "bio","followers","posts","styles":[...] }

Usage:
  ig_diy_browseract.py --browser <BROWSER_ID> --session ig --start 0 --count 20 --sleep 3
The browser must be created first (browser-act browser create --type stealth ...)
and this script opens/reuses one session on it, fetching sequentially with
pacing to stay under Instagram's rate limits.
"""
import argparse, json, os, re, subprocess, sys, time

BA = os.path.expanduser("~/.local/bin/browser-act")
QUEUE = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/artist-queue.json")
OUT = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/diy-profiles")
LOG = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/diy-run.log")
APP_ID = "936619743392459"

STYLE_VOCAB = {
    "Traditional": r"\btraditional\b(?!.{0,3}neo)", "Neo-Traditional": r"\bneo.?traditional\b",
    "Black & Grey": r"\bblack\s*(?:&|and|n)\s*gr[ae]y\b", "Blackwork": r"\bblack\s?work\b",
    "Fine Line": r"\bfine.?line\b", "Realism": r"\breal(?:ism|istic)\b",
    "Illustrative": r"\billustrat", "Japanese": r"\bjapanese\b|\birezumi\b",
    "Watercolor": r"\bwater\s?colou?r\b", "Geometric": r"\bgeometr", "Tribal": r"\btribal\b",
    "Chicano": r"\bchicano\b", "Anime": r"\banime\b|\bmanga\b", "Minimalist": r"\bminimal",
    "Script": r"\blettering\b|\bcalligraphy\b|\bscript\b",
}

def ba(session, *args, timeout=90):
    return subprocess.run([BA, "--session", session, *args], capture_output=True, text=True, timeout=timeout)

# JS: async IIFE (eval awaits the returned promise); same-origin fetch to the
# private endpoint with the required app-id header; returns user object as JSON.
FETCH_JS = (
    "(async () => {{ const r = await fetch("
    "'https://www.instagram.com/api/v1/users/web_profile_info/?username={h}',"
    "{{headers:{{'x-ig-app-id':'" + APP_ID + "'}},credentials:'include'}});"
    "if(!r.ok) return JSON.stringify({{__err:r.status}});"
    "const j = await r.json(); return JSON.stringify(j.data && j.data.user ? j.data.user : {{__err:'nouser'}}); }})()"
)

def parse_user(u, aid, handle):
    posts = u.get("edge_owner_to_timeline_media", {}) or {}
    edges = posts.get("edges", []) or []
    images = []
    for e in edges:
        n = e.get("node", {})
        url = n.get("display_url")
        if url and url not in images:
            images.append(url)
    bio = (u.get("biography") or "").strip()[:500]
    low = bio.lower()
    styles = [s for s, pat in STYLE_VOCAB.items() if re.search(pat, low)]
    return {
        "artistId": aid, "handle": handle,
        "source": "instagram-diy-browseract",
        "bio": bio or None,
        "followers": (u.get("edge_followed_by") or {}).get("count"),
        "following": (u.get("edge_follow") or {}).get("count"),
        "posts": posts.get("count"),
        "profilePic": u.get("profile_pic_url_hd") or u.get("profile_pic_url"),
        "styles": styles,
        "images": images[:8],
    }

def fetch_one(session, handle):
    # eval returns the JS return value; use --stdin to avoid shell-quoting the JS.
    js = FETCH_JS.format(h=handle)
    p = subprocess.run([BA, "--session", session, "eval", "--stdin"],
                       input=js, capture_output=True, text=True, timeout=90)
    out = (p.stdout or "").strip()
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return None, f"no-json rc={p.returncode} {out[:80] or (p.stderr or '')[:80]}"
    try:
        obj = json.loads(m.group(0))
    except Exception as e:
        return None, f"parse-fail {e}"
    if "__err" in obj:
        return None, f"ig-err {obj['__err']}"
    return obj, "ok"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", required=True, help="BrowserAct stealth browser id")
    ap.add_argument("--session", default="ig")
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--count", type=int, default=20)
    ap.add_argument("--sleep", type=float, default=3.0, help="seconds between profiles (rate-limit pacing)")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    queue = json.load(open(QUEUE))[a.start:a.start + a.count]
    log = open(LOG, "a")
    def w(m):
        line = f"[{time.strftime('%H:%M:%S')}] {m}"
        print(line, flush=True); log.write(line + "\n"); log.flush()

    # Park the session on instagram.com so fetch() is same-origin.
    w(f"opening session '{a.session}' on browser {a.browser}")
    op = ba(a.session, "browser", "open", a.browser, "https://www.instagram.com/", timeout=120)
    if op.returncode != 0:
        w(f"FATAL open failed: {(op.stderr or op.stdout)[:200]}"); sys.exit(1)
    time.sleep(4)

    ok = walled = err = 0
    for i, art in enumerate(queue):
        aid = art["id"]; handle = art["ig"].lstrip("@").strip()
        outfile = os.path.join(OUT, f"{aid}.json")
        if os.path.exists(outfile):
            w(f"{i+1}/{len(queue)} {handle}: skip-exists"); continue
        try:
            u, status = fetch_one(a.session, handle)
        except Exception as e:
            u, status = None, f"exc {type(e).__name__}"
        if u:
            rec = parse_user(u, aid, handle)
            tmp = outfile + ".tmp"
            with open(tmp, "w") as f: json.dump(rec, f, indent=1)
            os.replace(tmp, outfile)
            ok += 1
            w(f"{i+1}/{len(queue)} {handle}: ok imgs={len(rec['images'])} styles={len(rec['styles'])} foll={rec['followers']}")
        else:
            if "ig-err" in status or "nouser" in status: walled += 1
            else: err += 1
            w(f"{i+1}/{len(queue)} {handle}: FAIL {status}")
        time.sleep(a.sleep)
    w(f"DONE ok={ok} walled/blocked={walled} err={err} of {len(queue)} (hit-rate {ok/max(1,len(queue))*100:.0f}%)")
    ba(a.session, "session", "close", a.session)

if __name__ == "__main__":
    main()
