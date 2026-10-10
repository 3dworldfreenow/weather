"""Shared HTTP helpers and in-memory cache for the upstream data sources."""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

import requests

HTTP_TIMEOUT = 15
USER_AGENT = "el-nino-tracker/1.0 (+https://github.com/3dworldfreenow/weather)"


class UpstreamError(RuntimeError):
    """Raised when an upstream data provider fails or returns bad data."""

    def __init__(self, message: str, status: int | None = None, reason: str | None = None):
        super().__init__(message)
        self.status = status
        self.reason = reason

    @property
    def rate_limited(self) -> bool:
        return self.status == 429


class TTLCache:
    """Tiny thread-safe in-memory cache with per-entry expiry."""

    def __init__(self, max_entries: int = 512):
        self._data: dict[Any, tuple[float, Any]] = {}
        self._lock = threading.Lock()
        self._max_entries = max_entries

    def get_or_set(self, key: Any, ttl: float, factory: Callable[[], Any]) -> Any:
        now = time.monotonic()
        with self._lock:
            hit = self._data.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = factory()
        with self._lock:
            if len(self._data) >= self._max_entries:
                self._data = {k: v for k, v in self._data.items() if v[0] > now}
                if len(self._data) >= self._max_entries:
                    self._data.clear()
            self._data[key] = (now + ttl, value)
        return value

    def get(self, key: Any, default: Any = None) -> Any:
        with self._lock:
            hit = self._data.get(key)
            return hit[1] if hit and hit[0] > time.monotonic() else default

    def set(self, key: Any, value: Any, ttl: float) -> None:
        with self._lock:
            self._data[key] = (time.monotonic() + ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()


cache = TTLCache()
_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT


def _get_text(url: str) -> str:
    try:
        resp = _session.get(url, timeout=HTTP_TIMEOUT)
    except requests.RequestException as exc:
        raise UpstreamError(f"Request to {url} failed: {exc}") from exc
    if not resp.ok:
        raise UpstreamError(f"{url} returned HTTP {resp.status_code}", status=resp.status_code)
    return resp.text
