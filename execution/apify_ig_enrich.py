#!/usr/bin/env python3
"""Bulk Instagram enrichment via Apify's instagram-profile-scraper.

Reads the ranked artist queue, scrapes profiles in chunks through Apify
(their proxy pool + retries handle the rate-limiting we hit raw), and
writes one file per artist into the hosting-pipeline INPUT dir in the
shape scripts/host-artist-images.mjs consumes:
  { "artistId","handle","images":[...], "bio","followers","posts" }

Usage: apify_ig_enrich.py --start 0 --count 500 --chunk 100
"""
import argparse, json, os, sys, time, urllib.request, urllib.error

TOKEN = os.environ.get("APIFY_TOKEN") or open("/opt/org/.env").read().split("APIFY_TOKEN=")[1].split("\n")[0].strip()
ACTOR = "apify~instagram-profile-scraper"
QUEUE = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/artist-queue.json")
OUT = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/apify-profiles")
LOG = os.path.expanduser("~/tatt-scraper/data/enrichment/instagram/apify-run.log")

def api(method, url, body=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def run_chunk(usernames, log):
    # Start async run
    run = api("POST", f"https://api.apify.com/v2/acts/{ACTOR}/runs?token={TOKEN}",
              {"usernames": usernames})["data"]
    rid, dsid = run["id"], run["defaultDatasetId"]
    # Poll
    for _ in range(120):
        st = api("GET", f"https://api.apify.com/v2/actor-runs/{rid}?token={TOKEN}")["data"]["status"]
        if st in ("SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"):
            break
        time.sleep(5)
    items = api("GET", f"https://api.apify.com/v2/datasets/{dsid}/items?token={TOKEN}&clean=true")
    return st, items

def extract_images(row):
    imgs = []
    for p in (row.get("latestPosts") or []):
        u = p.get("displayUrl") or p.get("imageUrl")
        if u and u not in imgs:
            imgs.append(u)
    return imgs[:8]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--count", type=int, default=500)
    ap.add_argument("--chunk", type=int, default=100)
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    queue = json.load(open(QUEUE))[a.start:a.start + a.count]
    by_handle = {q["ig"].lstrip("@").strip().lower(): q["id"] for q in queue}
    log = open(LOG, "a")
    def w(m):
        line = f"[{time.strftime('%H:%M:%S')}] {m}"; print(line, flush=True); log.write(line + "\n"); log.flush()

    handles = [q["ig"].lstrip("@").strip() for q in queue]
    w(f"START Apify enrich slice={a.start}:{a.start+a.count} ({len(handles)} handles) chunk={a.chunk}")
    total_ok = total_img = 0
    for ci in range(0, len(handles), a.chunk):
        chunk = handles[ci:ci + a.chunk]
        try:
            st, items = run_chunk(chunk, log)
        except Exception as e:
            w(f"chunk {ci}: RUN ERROR {type(e).__name__}: {e}"); continue
        got = 0
        for row in items:
            uname = (row.get("username") or "").lower()
            aid = by_handle.get(uname)
            if not aid:
                continue
            imgs = extract_images(row)
            rec = {"artistId": aid, "handle": uname,
                   "bio": (row.get("biography") or None),
                   "followers": row.get("followersCount"),
                   "posts": row.get("postsCount"),
                   "profilePic": row.get("profilePicUrlHD") or row.get("profilePicUrl"),
                   "images": imgs}
            with open(os.path.join(OUT, f"{aid}.json"), "w") as f:
                json.dump(rec, f, indent=1)
            got += 1
            if imgs:
                total_img += 1
        total_ok += got
        w(f"chunk {ci//a.chunk+1}/{-(-len(handles)//a.chunk)} status={st} rows={len(items)} written={got} (cum written={total_ok}, with-images={total_img})")
    w(f"DONE written={total_ok} with-images={total_img} of {len(handles)}")

if __name__ == "__main__":
    main()
