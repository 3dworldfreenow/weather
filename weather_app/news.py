"""El Niño news and videos from free sources (no API keys).

* GDELT DOC 2.0 API  - news articles from around the world, many languages
* Google News RSS    - El Niño searches in several country/language editions
* YouTube RSS feeds  - latest videos of weather and climate agencies, filtered
                       to El Niño / ENSO topics (YouTube search needs a key, so
                       a few known explainers are also listed)
"""

from __future__ import annotations

import datetime as dt
import email.utils
import logging
import re
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import quote_plus, urlparse

from . import services

log = logging.getLogger(__name__)

GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_QUERY = '("El Nino" OR "El Niño")'
GOOGLE_NEWS_URL = "https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}"
YOUTUBE_FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={id}"
YOUTUBE_HANDLE_URL = "https://www.youtube.com/@{handle}"
YOUTUBE_SEARCH_URL = "https://www.youtube.com/results?search_query=El+Ni%C3%B1o"

NEWS_TTL = 30 * 60
MAX_ARTICLES = 150

# Google News editions: (country, language, hl, gl, ceid, query)
GOOGLE_NEWS_EDITIONS = [
    ("India", "English", "en-IN", "IN", "IN:en", "El Niño"),
    ("India", "Hindi", "hi", "IN", "IN:hi", "अल नीनो"),
    ("United States", "English", "en-US", "US", "US:en", "El Niño"),
    ("United Kingdom", "English", "en-GB", "GB", "GB:en", "El Niño"),
    ("Australia", "English", "en-AU", "AU", "AU:en", "El Niño"),
    ("Philippines", "English", "en-PH", "PH", "PH:en", "El Niño"),
    ("Peru", "Spanish", "es-419", "PE", "PE:es-419", "El Niño"),
    ("Brazil", "Portuguese", "pt-BR", "BR", "BR:pt-419", "El Niño"),
    ("France", "French", "fr", "FR", "FR:fr", "El Niño"),
    ("Indonesia", "Indonesian", "id", "ID", "ID:id", "El Nino"),
    ("Japan", "Japanese", "ja", "JP", "JP:ja", "エルニーニョ"),
]

# YouTube channels of weather/climate agencies. The channel ID is looked up
# from the handle; the fallback ID is used if that lookup fails.
YOUTUBE_CHANNELS = [
    {"name": "NOAA", "handle": "NOAA", "fallback": None},
    {"name": "NOAA Research", "handle": "NOAAResearch", "fallback": "UCRRxIPuwYd7eCvlA1f5wc6g"},
    {"name": "NASA", "handle": "NASA", "fallback": None},
    {"name": "World Meteorological Organization", "handle": "WMO", "fallback": None},
    {"name": "Met Office", "handle": "metoffice", "fallback": "UC40Tw2tFuMzK305mi7nj8rg"},
    {"name": "Bureau of Meteorology", "handle": "BureauofMeteorology", "fallback": "UCNOlLwBZQLUPYUs31hVFeSA"},
]

# Known explainers, always listed (the latest-videos feeds rarely cover El Niño).
EXPLAINER_VIDEOS = [
    {"id": "57S0Rw9L_hw", "title": "What Is El Niño?", "channel": "NOAA SciJinks",
     "page": "https://www.nesdis.noaa.gov/about/k-12-education/oceans-coasts/what-el-nino"},
]

TOPIC = re.compile(r"el\s+ni[ñn]o|la\s+ni[ñn]a|\benso\b|エルニーニョ|अल\s*नीनो", re.IGNORECASE)
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{22}$")

_ATOM = "{http://www.w3.org/2005/Atom}"
_YT = "{http://www.youtube.com/xml/schemas/2015}"
_MEDIA = "{http://search.yahoo.com/mrss/}"


def _safe_url(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url.strip())
    return url.strip() if parsed.scheme in ("http", "https") and parsed.netloc else None


def _iso(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# GDELT
# --------------------------------------------------------------------------

def parse_gdelt(data: dict[str, Any]) -> list[dict[str, Any]]:
    articles = []
    for a in data.get("articles") or []:
        url = _safe_url(a.get("url"))
        title = (a.get("title") or "").strip()
        if not url or not title:
            continue
        seen = None
        try:
            seen = dt.datetime.strptime(a.get("seendate", ""), "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            pass
        image = _safe_url(a.get("socialimage"))
        articles.append({
            "title": title,
            "url": url,
            "source": a.get("domain") or urlparse(url).netloc,
            "country": a.get("sourcecountry") or None,
            "language": a.get("language") or None,
            "published": _iso(seen),
            "image": image if image and image.startswith("https://") else None,
            "via": "GDELT",
        })
    return articles


def fetch_gdelt() -> list[dict[str, Any]]:
    data = services._get_json(GDELT_URL, {
        "query": GDELT_QUERY, "mode": "artlist", "format": "json",
        "maxrecords": 100, "sort": "datedesc", "timespan": "7d",
    })
    return parse_gdelt(data if isinstance(data, dict) else {})


# --------------------------------------------------------------------------
# Google News RSS
# --------------------------------------------------------------------------

def parse_google_news(xml: str, country: str, language: str) -> list[dict[str, Any]]:
    articles = []
    root = ET.fromstring(xml)
    for item in root.iter("item"):
        url = _safe_url(item.findtext("link"))
        title = (item.findtext("title") or "").strip()
        source = (item.findtext("source") or "").strip()
        if not url or not title:
            continue
        # Titles look like "Headline - Publisher".
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3].strip()
        published = None
        try:
            published = email.utils.parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            pass
        articles.append({
            "title": title,
            "url": url,
            "source": source or "Google News",
            "country": country,
            "language": language,
            "published": _iso(published),
            "image": None,
            "via": "Google News",
        })
    return articles


def fetch_google_news(edition: tuple) -> list[dict[str, Any]]:
    country, language, hl, gl, ceid, query = edition
    url = GOOGLE_NEWS_URL.format(q=quote_plus(f'"{query}"'), hl=hl, gl=gl, ceid=ceid)
    return parse_google_news(services._get_text(url), country, language)


# --------------------------------------------------------------------------
# YouTube
# --------------------------------------------------------------------------

def resolve_channel_id(channel: dict[str, Any]) -> str | None:
    def lookup() -> str | None:
        try:
            html = services._get_text(YOUTUBE_HANDLE_URL.format(handle=channel["handle"]))
        except services.UpstreamError:
            return channel["fallback"]
        m = re.search(r'<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_-]{22})"', html) \
            or re.search(r'"externalId":"(UC[A-Za-z0-9_-]{22})"', html)
        return m.group(1) if m else channel["fallback"]

    return services.cache.get_or_set(("yt-channel", channel["handle"]), 7 * 24 * 3600, lookup)


def parse_youtube_feed(xml: str, channel_name: str) -> list[dict[str, Any]]:
    videos = []
    root = ET.fromstring(xml)
    for entry in root.iter(f"{_ATOM}entry"):
        vid = entry.findtext(f"{_YT}videoId") or ""
        title = (entry.findtext(f"{_ATOM}title") or "").strip()
        description = entry.findtext(f"{_MEDIA}group/{_MEDIA}description") or ""
        if not VIDEO_ID.match(vid) or not TOPIC.search(f"{title} {description}"):
            continue
        published = None
        try:
            published = dt.datetime.fromisoformat(entry.findtext(f"{_ATOM}published") or "")
        except ValueError:
            pass
        videos.append({
            "id": vid,
            "title": title,
            "channel": entry.findtext(f"{_ATOM}author/{_ATOM}name") or channel_name,
            "published": _iso(published),
            "explainer": False,
        })
    return videos


def fetch_channel_videos(channel: dict[str, Any]) -> list[dict[str, Any]]:
    channel_id = resolve_channel_id(channel)
    if not channel_id or not CHANNEL_ID.match(channel_id):
        raise services.UpstreamError(f"No channel ID for @{channel['handle']}")
    return parse_youtube_feed(services._get_text(YOUTUBE_FEED_URL.format(id=channel_id)), channel["name"])


# --------------------------------------------------------------------------
# Combined feed
# --------------------------------------------------------------------------

def _title_key(title: str) -> str:
    return re.sub(r"\W+", "", title.lower())[:80]


def merge_articles(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for group in groups:
        for article in group:
            key = _title_key(article["title"])
            if key and key not in seen:
                seen[key] = article
            elif key and not seen[key].get("image") and article.get("image"):
                seen[key]["image"] = article["image"]
    articles = sorted(seen.values(), key=lambda a: a["published"] or "", reverse=True)
    return articles[:MAX_ARTICLES]


def get_news() -> dict[str, Any]:
    def build() -> dict[str, Any]:
        sources, groups, videos = [], [], []

        def run(name: str, kind: str, url: str, fn):
            try:
                items = fn()
                sources.append({"name": name, "kind": kind, "url": url, "ok": True, "count": len(items)})
                return items
            except (services.UpstreamError, ET.ParseError, KeyError, TypeError) as exc:
                log.warning("News source %s failed: %s", name, exc)
                sources.append({"name": name, "kind": kind, "url": url, "ok": False, "count": 0})
                return []

        groups.append(run("GDELT global news", "news", "https://www.gdeltproject.org/", fetch_gdelt))
        for edition in GOOGLE_NEWS_EDITIONS:
            groups.append(run(f"Google News {edition[0]} ({edition[1]})", "news", "https://news.google.com/",
                              lambda e=edition: fetch_google_news(e)))
        for channel in YOUTUBE_CHANNELS:
            videos += run(f"YouTube: {channel['name']}", "video",
                          YOUTUBE_HANDLE_URL.format(handle=channel["handle"]),
                          lambda c=channel: fetch_channel_videos(c))

        articles = merge_articles(groups)
        if not articles and not any(s["ok"] for s in sources if s["kind"] == "news"):
            raise services.UpstreamError("All news sources failed")
        videos = list({v["id"]: v for v in videos}.values())  # a video can appear on two channels
        videos.sort(key=lambda v: v["published"] or "", reverse=True)
        explainers = [{**v, "published": None, "explainer": True} for v in EXPLAINER_VIDEOS]
        return {
            "updated": _iso(dt.datetime.now(dt.timezone.utc)),
            "articles": articles,
            "videos": videos + explainers,
            "youtube_search": YOUTUBE_SEARCH_URL,
            "sources": sources,
        }

    return services.cache.get_or_set("news", NEWS_TTL, build)
