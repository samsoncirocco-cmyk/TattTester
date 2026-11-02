"""Polite public fetcher for in-house discovery.

One request at a time. No cookie jar, no login, no challenge solving.
Instagram and Google are skipped unless the operator names the host,
because their robots.txt disallows a generic crawler and a logged-out
browser is redirected to a login wall for profiles and following lists.
"""

from __future__ import annotations

import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlparse
from urllib import robotparser

from execution.inhouse_parse import DISALLOWED_HOSTS, host_of


USER_AGENT = (
    "TatTArtistBot/1.0 (+https://tatttester.com; public artist discovery; "
    "one request at a time, no login)"
)
DEFAULT_DELAY_S = 2.5
DEFAULT_MAX_REQUESTS = 400
MAX_BODY_BYTES = 1_000_000


@dataclass
class TransportResult:
    status: int
    headers: dict
    body: str
    final_url: str
    truncated: bool = False
    error: str | None = None


@dataclass
class FetchOutcome:
    url: str
    status: int
    body: str
    final_url: str
    fetch_status: str
    error: str | None = None
    truncated: bool = False


@dataclass
class PoliteFetcher:
    transport: Callable[[str, dict], TransportResult]
    delay_s: float = DEFAULT_DELAY_S
    max_requests: int = DEFAULT_MAX_REQUESTS
    user_agent: str = USER_AGENT
    allow_disallowed_hosts: frozenset[str] = field(default_factory=frozenset)
    sleep: Callable[[float], None] = time.sleep
    now: Callable[[], float] = time.monotonic
    robots_loader: Callable[[str], str | None] | None = None
    requests_made: int = 0
    _last_at: float | None = None
    _stopped_hosts: dict[str, str] = field(default_factory=dict)
    _robots: dict[str, str | None] = field(default_factory=dict)

    def fetch(self, url: str) -> FetchOutcome:
        host = host_of(url)
        if host in self._stopped_hosts:
            return FetchOutcome(url, 0, "", url, self._stopped_hosts[host], error="host stopped")

        allowed, reason = self._allowed(url)
        if not allowed:
            return FetchOutcome(url, 0, "", url, reason or "robots-disallow")

        if self.requests_made >= self.max_requests:
            return FetchOutcome(url, 0, "", url, "request-cap")

        self._pace()
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml",
        }
        result = self.transport(url, headers)
        self.requests_made += 1
        self._last_at = self.now()

        if result.error and result.status == 0:
            self._note_failure(host)
            return FetchOutcome(url, 0, "", url, "network-error", error=result.error)

        if result.status == 429:
            self._stopped_hosts[host] = "rate-limited"
            return FetchOutcome(
                url, 429, result.body, result.final_url or url, "rate-limited"
            )

        final = result.final_url or url
        body = result.body or ""
        if result.status == 202 or "anomaly-modal" in body.lower():
            self._stopped_hosts[host] = "challenge"
            return FetchOutcome(url, result.status, body, final, "challenge")

        if "/accounts/login" in final.lower():
            self._stopped_hosts[host] = "login-wall"
            return FetchOutcome(url, result.status, body, final, "login-wall")

        if result.status >= 400:
            self._note_failure(host)
            return FetchOutcome(url, result.status, body, final, f"http-{result.status}")

        return FetchOutcome(
            url, result.status, body, final, "ok", truncated=result.truncated
        )

    def _note_failure(self, host: str) -> None:
        key = f"failures:{host}"
        count = int(self._stopped_hosts.get(key, "0")) + 1
        self._stopped_hosts[key] = str(count)
        if count >= 3:
            self._stopped_hosts[host] = "host-errors"

    def _pace(self) -> None:
        if self._last_at is None:
            return
        wait = self.delay_s - (self.now() - self._last_at)
        if wait > 0:
            self.sleep(wait)

    def _allowed(self, url: str) -> tuple[bool, str | None]:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        bare = host.removeprefix("www.")
        if bare in {item.removeprefix("www.") for item in DISALLOWED_HOSTS} or host in DISALLOWED_HOSTS:
            allowed_bare = {item.lower().removeprefix("www.") for item in self.allow_disallowed_hosts}
            if bare not in allowed_bare and host not in self.allow_disallowed_hosts:
                return False, "robots-disallow"
            return True, None

        if bare == "google.com" and parsed.path.startswith("/search"):
            return False, "robots-disallow"

        origin = f"{parsed.scheme}://{parsed.netloc}"
        robots = self._robots_text(origin)
        if robots is None:
            return False, "robots-unknown"
        parser = robotparser.RobotFileParser()
        parser.parse(robots.splitlines())
        if not parser.can_fetch(self.user_agent, url):
            return False, "robots-disallow"
        return True, None

    def _robots_text(self, origin: str) -> str | None:
        if origin in self._robots:
            return self._robots[origin]
        if self.robots_loader is not None:
            text = self.robots_loader(origin)
        else:
            text = _fetch_robots(self.transport, origin, self.user_agent)
            self.requests_made += 1
        self._robots[origin] = text
        return text


def _fetch_robots(transport, origin: str, user_agent: str) -> str | None:
    try:
        result = transport(
            origin.rstrip("/") + "/robots.txt",
            {"User-Agent": user_agent, "Accept": "text/plain"},
        )
    except Exception:
        return None
    if result.status != 200 or not result.body:
        return None
    return result.body


def urllib_transport(url: str, headers: dict, timeout: int = 20) -> TransportResult:
    """Cookie-free GET. A redirect to a login wall is returned as the final URL."""
    request = urllib.request.Request(url, headers=headers, method="GET")
    opener = urllib.request.build_opener()
    # The default opener has no cookie jar. Build a fresh one per call so a
    # Set-Cookie on one response cannot be replayed on the next.
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_BODY_BYTES + 1)
            truncated = len(raw) > MAX_BODY_BYTES
            if truncated:
                raw = raw[:MAX_BODY_BYTES]
            return TransportResult(
                status=getattr(response, "status", 200),
                headers={k.lower(): v for k, v in response.headers.items()},
                body=raw.decode("utf-8", "replace"),
                final_url=response.geturl(),
                truncated=truncated,
            )
    except urllib.error.HTTPError as error:
        raw = error.read(MAX_BODY_BYTES) if error.fp else b""
        return TransportResult(
            status=error.code,
            headers={k.lower(): v for k, v in (error.headers.items() if error.headers else [])},
            body=raw.decode("utf-8", "replace"),
            final_url=getattr(error, "url", None) or url,
        )
    except Exception as error:
        return TransportResult(status=0, headers={}, body="", final_url=url, error=str(error))
