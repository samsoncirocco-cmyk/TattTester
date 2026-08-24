#!/usr/bin/env python3
"""Instagram enrichment via BrowserAct stealth-extract.

For each artist: fetch instagram.com/<handle>/ as markdown, parse bio /
counts / post URLs, optionally fetch top post pages (html) for og:image
portfolio URLs. Writes one JSON per artist plus raw markdown for
reprocessing. Deterministic parsing only — no invention.

Usage:
  ig_enrich_browseract.py --start 0 --count 50 --posts 3 --workers 6
  --posts 0 disables post-image fetches (profile-only breadth mode).
"""
import argparse, concurrent.futures as cf, json, os, re, subprocess, sys, time

BA = os.path.expanduser("~/.local/bin/browser-act")
QUEUE = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/artist-queue.json")
OUT = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/profiles")
RAW = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/raw")
LOG = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/run.log")

STYLE_VOCAB = {
    "Traditional": r"\btraditional\b(?!.{0,3}neo)", "Neo-Traditional": r"\bneo.?traditional\b",
    "Black & Grey": r"\bblack\s*(?:&|and|n)\s*gr[ae]y\b", "Blackwork": r"\bblack\s?work\b",
    "Fine Line": r"\bfine.?line\b", "Realism": r"\breal(?:ism|istic)\b",
    "Illustrative": r"\billustrat", "Japanese": r"\bjapanese\b|\birezumi\b",
    "Watercolor": r"\bwater\s?colou?r\b", "Geometric": r"\bgeometr",
    "Tribal": r"\btribal\b", "Chicano": r"\bchicano\b",
    "Anime": r"\banime\b|\bmanga\b", "Minimalist": r"\bminimal",
    "Script": r"\blettering\b|\bcalligraphy\b|\bscript\b",
}

def sh(args, timeout):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

def extract(url, ctype, timeout=150):
    r = sh([BA, "stealth-extract", url, "--content-type", ctype], timeout)
    return r.returncode, r.stdout

def parse_profile(md, handle):
    out = {"private": False, "loginWalled": False}
    if re.search(r"this account is private", md, re.I): out["private"] = True
    # login wall pages have no post counts
    m = re.search(r"\[?([\d,\.]+[km]?) posts", md, re.I)
    if m: out["posts"] = m.group(1)
    m = re.search(r"([\d,\.]+[km]?) followers", md, re.I)
    if m: out["followers"] = m.group(1)
    if "posts" not in out and "followers" not in out:
        out["loginWalled"] = True
        return out
    # bio: lines between the follows block and Highlights/Posts tabs
    seg = md
    m = re.search(r"following\]?\(.*?\)\n(.*?)(?:\n\* Highlights|\n\[Posts\]\(|\Z)", md, re.S | re.I)
    if m: seg = m.group(1)
    bio_lines = [l.strip(" *") for l in seg.splitlines()
                 if l.strip() and not re.match(r"^\[|^more$|^Options$|^Highlights$", l.strip())]
    bio = " ".join(bio_lines)[:500].strip()
    if bio: out["bio"] = bio
    low = (bio or seg).lower()
    styles = [s for s, pat in STYLE_VOCAB.items() if re.search(pat, low)]
    if styles: out["styles"] = styles
    posts = re.findall(r"https://www\.instagram\.com/[^)\s\"]+/(?:p|reel)/[A-Za-z0-9_\-]+/?", md)
    seen, ordered = set(), []
    for p in posts:
        if p not in seen:
            seen.add(p); ordered.append(p)
    out["postUrls"] = ordered[:8]
    return out

def post_image(url):
    code, html_txt = extract(url, "html", timeout=150)
    if code != 0: return None
    m = re.search(r'property="og:image"\s+content="([^"]+)"', html_txt) or \
        re.search(r'content="([^"]+)"\s+property="og:image"', html_txt)
    return (m.group(1).replace("&amp;", "&") if m else None)

def process(artist, n_posts):
    aid, handle = artist["id"], artist["ig"].lstrip("@").strip()
    outfile = os.path.join(OUT, f"{aid}.json")
    if os.path.exists(outfile): return (aid, "skip-exists", 0)
    t0 = time.time()
    fetches = 0
    try:
        code, md = extract(f"https://www.instagram.com/{handle}/", "markdown")
        fetches += 1
        if code != 0 or not md.strip():
            return (aid, f"profile-fetch-failed rc={code}", fetches)
        with open(os.path.join(RAW, f"{aid}.md"), "w") as f: f.write(md)
        rec = {"artistId": aid, "handle": handle, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
               "source": "instagram-browseract-stealth", **parse_profile(md, handle)}
        images = []
        if not rec.get("private") and not rec.get("loginWalled"):
            for purl in rec.get("postUrls", [])[:n_posts]:
                img = post_image(purl); fetches += 1
                if img: images.append({"post": purl, "image": img})
        if images: rec["portfolioImages"] = images
        tmp = outfile + ".tmp"
        with open(tmp, "w") as f: json.dump(rec, f, indent=1)
        os.replace(tmp, outfile)
        status = "private" if rec.get("private") else ("login-walled" if rec.get("loginWalled") else
                 f"ok bio={'y' if rec.get('bio') else 'n'} styles={len(rec.get('styles',[]))} imgs={len(images)}")
        return (aid, f"{status} {time.time()-t0:.0f}s", fetches)
    except Exception as e:
        return (aid, f"error {type(e).__name__}: {e}", fetches)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--posts", type=int, default=3)
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True); os.makedirs(RAW, exist_ok=True)
    queue = json.load(open(QUEUE))[a.start:a.start + a.count]
    log = open(LOG, "a")
    def w(msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True); log.write(line + "\n"); log.flush()
    w(f"START slice={a.start}:{a.start+a.count} posts={a.posts} workers={a.workers}")
    total_fetches, done = 0, 0
    with cf.ThreadPoolExecutor(max_workers=a.workers) as ex:
        futs = {ex.submit(process, art, a.posts): art for art in queue}
        for fut in cf.as_completed(futs):
            aid, status, fetches = fut.result()
            total_fetches += fetches; done += 1
            w(f"{done}/{len(queue)} {aid}: {status} (fetches so far: {total_fetches})")
    w(f"DONE slice={a.start}:{a.start+a.count} artists={done} fetches={total_fetches}")

if __name__ == "__main__":
    main()
