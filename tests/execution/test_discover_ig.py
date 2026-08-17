import json

import pytest

import execution.discover_ig as discovery


def write_queue(path):
    path.write_text(json.dumps([{"id": "artist-1", "ig": "@ink.sam"}]))


def test_discovery_token_is_environment_only(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="APIFY_TOKEN is required"):
        discovery.load_token()
    monkeypatch.setenv("APIFY_TOKEN", "secret")
    assert discovery.load_token() == "secret"


def test_discovery_api_uses_bearer_header_and_clean_url(monkeypatch):
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return b'{"data": {"ok": true}}'

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(discovery.urllib.request, "urlopen", fake_urlopen)
    result = discovery.api("secret-value", "GET", "/actor-runs/run-1")
    assert result["data"]["ok"] is True
    assert captured["request"].get_header("Authorization") == "Bearer secret-value"
    assert "secret-value" not in captured["request"].full_url
    assert "token=" not in captured["request"].full_url


def test_paid_discovery_is_dry_run_without_execute(tmp_path, monkeypatch, capsys):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    monkeypatch.setattr(
        discovery,
        "load_token",
        lambda: (_ for _ in ()).throw(AssertionError("token loaded during dry run")),
    )
    assert (
        discovery.main(
            [
                "--queue",
                str(queue),
                "--out",
                str(tmp_path / "out"),
                "collect-followees",
                "--seeds",
                "ink.seed",
            ]
        )
        == 0
    )
    assert "DRY RUN" in capsys.readouterr().out
    assert not (tmp_path / "out").exists()


def test_paid_discovery_requires_sweep_id_before_loading_token(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    monkeypatch.setattr(
        discovery,
        "load_token",
        lambda: (_ for _ in ()).throw(AssertionError("token loaded without sweep ID")),
    )
    with pytest.raises(SystemExit):
        discovery.main(
            [
                "--queue",
                str(queue),
                "--execute",
                "collect-followees",
                "--seeds",
                "ink.seed",
            ]
        )


def test_discovery_requires_explicit_valid_queue(tmp_path):
    with pytest.raises(SystemExit):
        discovery.main(["stats"])
    with pytest.raises(RuntimeError, match="does not exist"):
        discovery.main(["--queue", str(tmp_path / "missing.json"), "stats"])
    empty = tmp_path / "empty.json"
    empty.write_text("[]")
    with pytest.raises(RuntimeError, match="non-empty"):
        discovery.main(["--queue", str(empty), "stats"])


def test_ambiguous_discovery_post_is_durably_reported_and_not_cached(
    tmp_path,
    monkeypatch,
):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    report = tmp_path / "discovery-report.json"
    out = tmp_path / "out"
    monkeypatch.setattr(discovery, "load_token", lambda: "secret")
    monkeypatch.setattr(
        discovery,
        "api",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("unknown POST result")
        ),
    )

    with pytest.raises(RuntimeError, match="failed and was not cached"):
        discovery.main(
            [
                "--queue",
                str(queue),
                "--out",
                str(out),
                "--run-report",
                str(report),
                "--sweep-id",
                "discovery-1",
                "--execute",
                "collect-followees",
                "--seeds",
                "ink.seed",
            ]
        )

    sweep = json.loads(report.read_text())["sweeps"]["discovery-1"]
    assert len(sweep["actorRuns"]) == 1
    assert sweep["actorRuns"][0]["status"] == "POST_ERROR"
    assert sweep["apifyUsageAmbiguousAttemptCount"] == 1
    assert sweep["apifyUsagePricingStatus"] == "incomplete"
    assert not (out / "raw_followees.json").exists()


@pytest.mark.parametrize("actor_status", ["RUNNING", "FAILED"])
def test_nonterminal_or_failed_discovery_actor_never_fetches_or_caches(
    actor_status,
    monkeypatch,
):
    requests = []

    def fake_api(_token, method, path, body=None, timeout=180):
        requests.append((method, path))
        if method == "POST":
            return {
                "data": {
                    "id": "run-1",
                    "defaultDatasetId": "dataset-1",
                    "status": "READY",
                }
            }
        return {
            "data": {
                "id": "run-1",
                "status": actor_status,
                "usageTotalUsd": 0.25,
            }
        }

    monkeypatch.setattr(discovery, "api", fake_api)
    monkeypatch.setattr(discovery.time, "sleep", lambda _seconds: None)
    checkpoints = []
    with pytest.raises(RuntimeError, match="did not succeed"):
        discovery.run_actor(
            "secret",
            discovery.FOLLOW_ACTOR,
            {"username": "ink.seed"},
            checkpoint=checkpoints.append,
            operation="collect-followees:ink.seed",
            poll_max=1,
            attempt_id="attempt-1",
        )
    assert all("/datasets/" not in path for _, path in requests)
    assert checkpoints[-1]["status"] == actor_status
    assert checkpoints[-1]["terminal"] is (actor_status == "FAILED")


def test_failed_discovery_seed_remains_retryable_until_terminal_success(
    tmp_path,
    monkeypatch,
):
    raw_path = tmp_path / "raw_followees.json"
    calls = {"count": 0}

    def fake_run_actor(*_args, **_kwargs):
        calls["count"] += 1
        if calls["count"] == 1:
            raise RuntimeError("actor failed")
        return "SUCCEEDED", [{"username": "new.artist"}]

    monkeypatch.setattr(discovery, "run_actor", fake_run_actor)
    with pytest.raises(RuntimeError, match="failed and was not cached"):
        discovery.collect_followees(
            "secret",
            ["ink.seed"],
            100,
            raw_path,
            lambda _record: None,
        )
    assert not raw_path.exists()

    result = discovery.collect_followees(
        "secret",
        ["ink.seed"],
        100,
        raw_path,
        lambda _record: None,
    )
    assert calls["count"] == 2
    assert result["ink.seed"] == ["new.artist"]


APIFY_PROFILE_ITEM = {
    "username": "InkBySam",
    "biography": "Tattoo artist. Booking below.",
    "followersCount": 5000,
    "postsCount": 1845,
    "fullName": "Sam Ink",
    "externalUrl": "https://example.com/book",
    "businessCategoryName": "Artist",
    "private": False,
    "verified": False,
}


def test_profile_row_captures_the_post_count_the_importer_gates_on():
    row = discovery.profile_row(APIFY_PROFILE_ITEM)
    assert row["postCount"] == 1845
    # every field the shared classifier and the importer already read
    assert row["bio"] == "Tattoo artist. Booking below."
    assert row["followers"] == 5000
    assert row["fullName"] == "Sam Ink"
    assert row["url"] == "https://example.com/book"
    assert row["category"] == "Artist"
    assert row["private"] is False
    assert row["verified"] is False


def test_zero_posts_is_not_collapsed_into_never_scraped():
    # The importer rejects 0 (empty profile) and holds None (no evidence).
    # Collapsing them turns a decision into an indefinite wait.
    assert discovery.profile_row({**APIFY_PROFILE_ITEM, "postsCount": 0})["postCount"] == 0
    absent = {key: value for key, value in APIFY_PROFILE_ITEM.items() if key != "postsCount"}
    assert discovery.profile_row(absent)["postCount"] is None


def test_profile_row_tolerates_actor_schema_drift():
    absent = {key: value for key, value in APIFY_PROFILE_ITEM.items() if key != "postsCount"}
    assert discovery.profile_row({**absent, "mediaCount": 12})["postCount"] == 12


def test_missing_post_count_finds_profiles_cached_before_the_field_existed():
    profiles = {
        "legacy": {"bio": "x", "followers": 10},
        "explicit_null": {"bio": "y", "postCount": None},
        "repaired": {"bio": "z", "postCount": 400},
        "empty_but_scraped": {"bio": "w", "postCount": 0},
        "unreadable": None,
    }
    assert sorted(discovery.missing_post_count(profiles)) == [
        "explicit_null",
        "legacy",
        "unreadable",
    ]
    assert discovery.missing_post_count({"a": {"postCount": 1}}) == []


def test_backfill_rescrapes_stale_profiles_and_plain_enrich_does_not(tmp_path, monkeypatch, capsys):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    profiles_path = tmp_path / "profiles.json"
    profiles_path.write_text(json.dumps({"stale.artist": {"bio": "old", "followers": 1}}))
    raw_followees = tmp_path / "raw_followees.json"
    raw_followees.write_text(json.dumps({"seed": ["stale.artist", "brand.new"]}))
    raw_hashtags = tmp_path / "raw_hashtags.json"
    raw_hashtags.write_text(json.dumps({}))

    scraped = []

    def fake_run_actor(_token, _actor, payload, **_kwargs):
        scraped.append(list(payload["usernames"]))
        return "SUCCEEDED", [
            {**APIFY_PROFILE_ITEM, "username": name} for name in payload["usernames"]
        ]

    monkeypatch.setattr(discovery, "run_actor", fake_run_actor)

    def run(backfill):
        discovery.enrich_candidates(
            "secret",
            200,
            queue_path=queue,
            raw_followees_path=raw_followees,
            raw_hashtags_path=raw_hashtags,
            profiles_path=profiles_path,
            checkpoint=lambda _record: None,
            backfill=backfill,
        )

    run(False)
    assert scraped == [["brand.new"]], "plain enrich must not re-spend on cached handles"
    assert "stale.artist" in discovery.missing_post_count(json.loads(profiles_path.read_text()))
    assert "--backfill" in capsys.readouterr().out

    scraped.clear()
    run(True)
    assert scraped == [["stale.artist"]]
    assert discovery.missing_post_count(json.loads(profiles_path.read_text())) == []


def test_filter_warns_when_accepted_candidates_have_no_photo_evidence(tmp_path, capsys):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    raw_followees = tmp_path / "raw_followees.json"
    raw_followees.write_text(json.dumps({"seed": ["no.evidence", "has.evidence"]}))
    raw_hashtags = tmp_path / "raw_hashtags.json"
    raw_hashtags.write_text(json.dumps({}))
    profiles_path = tmp_path / "profiles.json"
    profiles_path.write_text(
        json.dumps(
            {
                "no.evidence": {"bio": "Tattoo artist, books open", "followers": 900},
                "has.evidence": {
                    "bio": "Tattoo artist, books open",
                    "followers": 900,
                    "postCount": 300,
                },
            }
        )
    )
    candidates_path = tmp_path / "candidates.json"

    discovery.filter_candidates(
        queue_path=queue,
        raw_followees_path=raw_followees,
        raw_hashtags_path=raw_hashtags,
        profiles_path=profiles_path,
        candidates_path=candidates_path,
    )

    written = {item["handle"]: item for item in json.loads(candidates_path.read_text())}
    assert written["has.evidence"]["postCount"] == 300
    assert written["no.evidence"]["postCount"] is None
    output = capsys.readouterr().out
    assert "WARNING: 1 of 2 accepted candidates have no postCount" in output


def test_a_sparse_rescrape_never_erases_what_we_already_knew():
    # Observed live during the #364 backfill: 8 of 338 handles came back with
    # every field stripped (gone private / renamed / deleted since the first
    # run). Before --backfill existed this was unreachable, because cached
    # handles were never re-scraped.
    cached = {
        "bio": "Tattoo artist, books open",
        "followers": 37,
        "fullName": "Real Name",
        "url": "https://example.com",
        "category": "Artist",
        "private": True,
        "verified": False,
    }
    stripped = discovery.profile_row({"username": "gone.dark"})
    merged = discovery.merge_profile(cached, stripped)
    assert merged["bio"] == "Tattoo artist, books open"
    assert merged["followers"] == 37
    assert merged["fullName"] == "Real Name"
    assert merged["private"] is True
    assert merged["postCount"] is None


def test_fresh_values_win_including_falsey_ones_that_carry_information():
    cached = {"bio": "old bio", "followers": 10, "postCount": 500, "private": True}
    fresh = discovery.profile_row(
        {
            "username": "still.here",
            "biography": "new bio",
            "followersCount": 20,
            "postsCount": 0,
            "private": False,
        }
    )
    merged = discovery.merge_profile(cached, fresh)
    assert merged["bio"] == "new bio"
    assert merged["followers"] == 20
    # 0 posts and private=False are answers, not absences
    assert merged["postCount"] == 0
    assert merged["private"] is False


def test_merge_profile_handles_an_uncached_or_unreadable_entry():
    fresh = discovery.profile_row(APIFY_PROFILE_ITEM)
    assert discovery.merge_profile(None, fresh) == fresh
    assert discovery.merge_profile("corrupt", fresh) == fresh


def test_backfill_of_a_vanished_account_keeps_the_cached_row(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    write_queue(queue)
    profiles_path = tmp_path / "profiles.json"
    profiles_path.write_text(
        json.dumps({"gone.dark": {"bio": "Tattoo artist", "followers": 37, "private": True}})
    )
    raw_followees = tmp_path / "raw_followees.json"
    raw_followees.write_text(json.dumps({"seed": ["gone.dark"]}))
    raw_hashtags = tmp_path / "raw_hashtags.json"
    raw_hashtags.write_text(json.dumps({}))

    monkeypatch.setattr(
        discovery,
        "run_actor",
        lambda *_args, **_kwargs: ("SUCCEEDED", [{"username": "gone.dark"}]),
    )
    discovery.enrich_candidates(
        "secret",
        200,
        queue_path=queue,
        raw_followees_path=raw_followees,
        raw_hashtags_path=raw_hashtags,
        profiles_path=profiles_path,
        checkpoint=lambda _record: None,
        backfill=True,
    )
    stored = json.loads(profiles_path.read_text())["gone.dark"]
    assert stored["bio"] == "Tattoo artist"
    assert stored["followers"] == 37
    assert stored["postCount"] is None
