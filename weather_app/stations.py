"""Weather station reports (METAR) from about 5,000 airports worldwide, used to check
the radar prediction on the ground: is it raining at nearby stations right now, and
did the temperature just drop (a sign of a rain or thunderstorm cold pool)?

Source: NOAA Aviation Weather Center (https://aviationweather.gov/, public domain).
Its cache file holds each station's newest report. The browser cannot read it
directly (no CORS), so the static build stores it and keeps the reports of the last
few hours from the previously published copy, giving a short temperature history.
"""

from __future__ import annotations

import csv
import datetime as dt
import gzip
import io
import logging
from typing import Any

import requests

from . import services

log = logging.getLogger(__name__)

CACHE_URL = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"
ATTRIBUTION = 'Stations: <a href="https://aviationweather.gov/">NOAA Aviation Weather Center</a>'
KEEP_HOURS = 3


def _download() -> str:
    try:
        resp = services._session.get(CACHE_URL, timeout=60)
    except requests.RequestException as exc:
        raise services.UpstreamError(f"Request to {CACHE_URL} failed: {exc}") from exc
    if not resp.ok:
        raise services.UpstreamError(f"{CACHE_URL} returned HTTP {resp.status_code}", status=resp.status_code)
    data = resp.content
    return (gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data).decode("utf-8", "replace")


def parse(text: str) -> dict[str, dict[str, Any]]:
    """Newest report per station: {id: {lat, lon, obs: [[minute, temp, wx]]}}."""
    out: dict[str, dict[str, Any]] = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            sid = row["station_id"]
            lat, lon = float(row["latitude"]), float(row["longitude"])
            t = dt.datetime.fromisoformat(row["observation_time"].replace("Z", "+00:00"))
            temp = round(float(row["temp_c"]), 1) if row.get("temp_c") else None
        except (KeyError, ValueError):
            continue
        minute = int(t.timestamp() // 60)
        if sid in out and out[sid]["obs"][0][0] >= minute:
            continue
        out[sid] = {"lat": round(lat, 3), "lon": round(lon, 3), "obs": [[minute, temp, (row.get("wx_string") or "").strip()]]}
    return out


def merge(fresh: dict[str, dict[str, Any]], previous: dict[str, Any] | None, now: dt.datetime) -> list[list]:
    """Stations as [id, lat, lon, [[minute, temp, wx], …]] with the last KEEP_HOURS of reports."""
    since = int(now.timestamp() // 60) - KEEP_HOURS * 60
    old = {s[0]: s for s in (previous or {}).get("stations", []) if isinstance(s, list) and len(s) == 4}
    stations = []
    for sid in sorted(set(fresh) | set(old)):
        obs = {o[0]: o for o in (old[sid][3] if sid in old else [])}
        if sid in fresh:
            obs.update({o[0]: o for o in fresh[sid]["obs"]})
            lat, lon = fresh[sid]["lat"], fresh[sid]["lon"]
        else:
            lat, lon = old[sid][1], old[sid][2]
        recent = sorted(o for o in obs.values() if o[0] >= since)
        if recent:
            stations.append([sid, lat, lon, recent])
    return stations


def get_stations(previous: dict[str, Any] | None = None, now: dt.datetime | None = None) -> dict[str, Any]:
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        fresh = parse(_download())
    except services.UpstreamError as exc:
        if previous:
            log.warning("Station reports failed, keeping the previous ones: %s", exc)
            return previous
        raise
    return {"built_at": now.isoformat(timespec="seconds"), "attribution": ATTRIBUTION,
            "stations": merge(fresh, previous, now)}
