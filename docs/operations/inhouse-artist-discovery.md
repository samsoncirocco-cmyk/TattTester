---
status: current
verified_against: 7e5cd71
verified_on: 2026-10-28
---

# In-house artist discovery

Public-page replacement for the Apify actors TattTester used to find US tattoo
artists. The output is the candidate file
`scripts/import-discovery-to-neo4j.mjs` already imports. Nothing in this lane
writes to Neo4j.

Apify discovery (`execution/discover_ig.py`) is unchanged. Use this lane when
the goal is more artists per dollar from pages a browser can open without a
login.

## What a logged-out browser actually returns

Observed 2026-10-28 with REA 6.8.0 `capture-browser-scenario` (Playwright,
fresh Chrome profile, no cookies) plus the public `robots.txt` files.

| Surface | What came back |
| --- | --- |
| `https://www.instagram.com/instagram/` | 302, then `200` on `/accounts/login/?next=…&is_from_rle`. The page then loaded login JS and called `/ajax/qm`, `/ajax/bz`, and `/ajax/bulk-route-definitions`. No profile JSON. |
| `https://www.instagram.com/instagram/following/` | Same login redirect. No following list. |
| `https://www.instagram.com/explore/tags/finelinetattoo/` | Redirected to `/popular/finelinetattoo/`. |
| `https://www.instagram.com/popular/finelinetattoo/` | `200`. Title of the form “Finelinetattoo • 50M reels on Instagram”. The static HTML is a script shell: `og` tags, language links back to `/popular/`, not a list of owner handles. |
| `https://html.duckduckgo.com/html/?q=tattoo+artist+Austin+TX+site:instagram.com` | HTTP 202 and an `anomaly-modal` puzzle. Zero result links. |
| `http://timelesstattoo.co/artists` | 308 to https, then `200`. Generator `Starfield Technologies; Go Daddy Website Builder 8.0.0000`. Static HTML contained `mailto:`, `tel:`, and Instagram hrefs. Scripts came from `img1.wsimg.com` and `csp.secureserver.net`. |

Instagram's `robots.txt` ends with `User-agent: *` / `Disallow: /` and says
automated collection needs written permission. Google's `robots.txt` disallows
`/search` for `User-agent: *`. DuckDuckGo's HTML `robots.txt` is `Allow: /`.

This lane therefore does not log in, does not keep a cookie jar, does not call
`/ajax/*`, and does not solve the DuckDuckGo puzzle or an Instagram login
wall. A challenge or a login wall stops that host.

## Commands

Queue records are the same `{id, ig}` objects `discover_ig.py` requires.
`--reference` is an optional JSON object `{ "artists": [ … ] }` used only to
skip handles already in the graph. Include `claimedByUid`, `selfRegistered`,
`removedAt`, `claimVerificationStatus`, and `pendingTakedown` when you have
them. Protected artists are omitted from `candidates.json`, not just marked
duplicate.

```bash
python execution/inhouse_discover.py --queue queue.json --metro "Austin,TX" plan

# Search. Dry-run prints the URL. --execute fetches DuckDuckGo HTML.
python execution/inhouse_discover.py --queue queue.json --metro "Austin,TX" collect-search
python execution/inhouse_discover.py --queue queue.json --metro "Austin,TX" --execute collect-search

# A results page you saved yourself. No network.
python execution/inhouse_discover.py --queue queue.json --metro "Austin,TX" \
  collect-search --html-file results.html

# Shop rosters. sites.json is [{ "url", "shopName", "city", "state" }].
python execution/inhouse_discover.py --queue queue.json --sites shops.json --execute collect-sites

# @handles already written in collected bios. No network.
python execution/inhouse_discover.py --queue queue.json --out data/discovery/inhouse collect-mentions

# Hashtag shell. Skipped unless you name the host. A shell stores no owners.
python execution/inhouse_discover.py --queue queue.json --execute \
  --allow-disallowed-hosts instagram.com collect-hashtags --tags finelinetattoo

# Profile URLs. Off unless the host is named, and a login wall stops the run.
python execution/inhouse_discover.py --queue queue.json --out data/discovery/inhouse enrich

python execution/inhouse_discover.py --queue queue.json --out data/discovery/inhouse filter
python execution/inhouse_discover.py --queue queue.json --out data/discovery/inhouse stats
```

`filter` writes:

- `candidates.json` — `handle`, `source`, `seedFrom`, `seedCity`, `seedState`, `bioSnippet`, `followers`, `looksBookable`, `filterReason`, `styles`
- `profiles.json` — the profile map the importer reads (`bio`, `fullName`, `followers`, `url`, `postCount`, `private`)
- `style-harvest.json` — input for `scripts/link-artist-styles.mjs`
- `dedupe-report.json` — known and protected handles that were left out

Styles come from `scripts/lib/artist-styles.mjs`, including its negation
guard. A roster bio is only the shop name, city, and state the site record
supplied, plus the text of that one artist's card. A shared block that links
several artists does not donate its text to each of them.

Import is still a separate dry-run. Shop rows usually have no follower count
and no post count, so the default gates hold them. Admitting that weaker
evidence is an explicit flag, and `--apply` is still required to write:

```bash
node scripts/import-discovery-to-neo4j.mjs \
  --input data/discovery/inhouse/candidates.json \
  --profiles data/discovery/inhouse/profiles.json \
  --allow-unknown-followers \
  --allow-unknown-photos

node scripts/link-artist-styles.mjs \
  --input data/discovery/inhouse/style-harvest.json \
  --source inhouse-discovery
```

`seedCity` / `seedState` are used only when the bio and a known seed account
do not already locate the artist. The city spelling is the one you passed, so
it should match the graph's `:City` name when you want them to merge.

A useful reference export:

```cypher
MATCH (a:Artist)
OPTIONAL MATCH (r:TakedownRequest {status: 'pending', artistId: a.id})
RETURN a.id AS id, a.name AS name, a.instagram AS instagram,
       a.city AS city, a.state AS state,
       a.claimedByUid AS claimedByUid,
       a.selfRegistered AS selfRegistered,
       a.removedAt AS removedAt,
       a.claimVerificationStatus AS claimVerificationStatus,
       r IS NOT NULL AS pendingTakedown
```

Wrap the rows as `{ "artists": [ … ] }` and pass `--reference`. The importer
still refuses claimed, removed, self-registered, and tombstoned artists at
write time even if this file is stale.

`execution/scrape_artists.py` already turns a Places text search into shop
websites. Reshape that `shops.json` into the `--sites` file. That is the seed
that does not depend on Google result HTML.

## Cost

Actor spend on this lane is $0. The Apify console starting prices used for
the comparison, per 1,000 units, were:

| Actor | Starting price | What this lane does instead |
| --- | --- | --- |
| `apify/instagram-profile-scraper` | $2.60 / 1,000 profiles | Parses a public profile document. A logged-out fetch currently redirects to login, so this does not yet return bios. |
| `apify/instagram-hashtag-scraper` | $2.60 / 1,000 results | Would read `/popular/{tag}/`. That document is a JS shell, not an owner list. |
| `coderx` followers/following, no cookies | $5.00 / 1,000 items | Not available logged out. Replaced by `@mentions` in bios and Instagram links on shop rosters. |
| `vdrmota/contact-info-scraper` | $2.00 / 1,000 pages | `mailto:`, `tel:`, and booking hosts from the shop HTML. |
| `apify/google-search-scraper` | $4.50 / 1,000 pages | DuckDuckGo HTML, or a results file you saved. Google `/search` is disallowed by robots. |
| `apify/rag-web-browser` | $2.28 / 1,000 pages | The same shop fetch. No second browser. |
| `botflowtech/website-technology-stack-detector` | $10.00 / 1,000 results | Generator meta and script host. GoDaddy Website Builder, Squarespace, Wix, Shopify, WordPress, Webflow. |

One shop fetch replaces the contact, page-read, and tech-stack actors: about
$14.28 per 1,000 pages at those starting rates. Profile fetches, if they ever
return a public document, avoid $2.60 per 1,000. The 361 profile runs are the
volume center. `discover_ig.py` sends 50 usernames per run, so 361 full runs
would be about 18,000 profiles and about $47 at the starting rate. Treat that
as a ceiling illustration. The console screenshot does not include item
totals, so it is not a reconstruction of the bill.

## Rate limits

- One request at a time.
- 2.5 seconds between requests (`--delay-seconds`).
- 400 requests per process (`--max-requests`), including a `robots.txt` fetch
  when the host is not on the disallow list.
- `User-Agent` is `TatTArtistBot/1.0`. No `Cookie` header is sent, and
  `Set-Cookie` is not stored.
- Missing or unreadable `robots.txt` skips the host (`robots-unknown`).
- `instagram.com` and `google.com` are skipped unless
  `--allow-disallowed-hosts` names that host. Naming the host does not turn a
  login wall into a profile.
- HTTP 429, a login redirect, or a challenge page stops the host for the rest
  of the process.
- Three HTTP or network errors on one host stop it.
- A blocked query stays in `raw_search.json` / `raw_hashtags.json`. The next
  run will not hit it again unless you pass `--retry-blocked`.
- Successful search and shop results are cached and not refetched.

At 2.5 seconds, a full 400-request run is about 17 minutes and at most 1,440
requests an hour if you raise the cap. 500–1,000 new artists a week fits that
budget when a shop roster yields several handles per page. It does not fit
while Instagram profile URLs answer with a login wall: those requests add
zero artists. The practical weekly source is shop URLs you already have, or
Places results from `scrape_artists.py`, plus mentions in bios you already
collected.

## Decisions still open

- Whether to pass `--allow-disallowed-hosts instagram.com` at all. REA showed
  it does not currently reveal profiles or following lists.
- Whether a shop-roster row with no follower count and no post count is
  importable (`--allow-unknown-followers` and `--allow-unknown-photos`).
  The default gates still hold those rows.
- No new secret is required for the default lane. A later official Instagram
  discovery path would need a Meta app and would only see professional
  accounts. `GOOGLE_PLACES_API_KEY` is the existing key for shop seeds.
