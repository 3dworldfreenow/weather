"""El Niño news and videos from free sources (no API keys).

* GDELT DOC 2.0 API  - news articles from around the world, many languages
* Google News RSS    - El Niño searches in ~35 country/language editions and
                       worldwide searches per impact theme
* Bing News RSS      - El Niño searches in several markets
* Humanitarian reports - ReliefWeb, FAO, WFP, OCHA, IFRC, UNICEF and FEWS NET
                       (searched through Google News)
* Science & agency RSS feeds (NOAA Climate.gov, NASA Earth Observatory, UN News,
  Carbon Brief, Phys.org, ScienceDaily), filtered to El Niño / ENSO
* arXiv and Crossref - new research papers
* Hacker News (Algolia API) - discussions
* Apple Podcasts search - podcast episodes
* YouTube RSS feeds  - latest videos of weather and climate agencies, filtered
                       to El Niño / ENSO topics (YouTube search needs a key, so
                       a few known explainers are also listed)

Every item has a `kind`: news, report, science, paper, discussion or podcast.
"""

from __future__ import annotations

import datetime as dt
import email.utils
import logging
import re
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import parse_qs, quote_plus, urlparse

from . import crops, impacts, services

log = logging.getLogger(__name__)

GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_QUERY = '("El Nino" OR "El Niño")'
GOOGLE_NEWS_URL = "https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}"
YOUTUBE_FEED_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={id}"
YOUTUBE_HANDLE_URL = "https://www.youtube.com/@{handle}"
YOUTUBE_SEARCH_URL = "https://www.youtube.com/results?search_query=El+Ni%C3%B1o"

BING_NEWS_URL = "https://www.bing.com/news/search?q={q}&format=rss&mkt={mkt}"
# Humanitarian reports: ReliefWeb's own feed blocks automated requests, so search
# the humanitarian agencies' sites through Google News.
REPORTS_QUERY = ('("El Niño" OR "El Nino") (site:reliefweb.int OR site:fao.org OR site:wfp.org '
                 'OR site:unocha.org OR site:ifrc.org OR site:unicef.org OR site:fews.net)')
ARXIV_URL = ("https://export.arxiv.org/api/query?search_query=all:%22El%20Nino%22%20OR%20all:ENSO"
             "&sortBy=submittedDate&sortOrder=descending&max_results=30")
CROSSREF_URL = "https://api.crossref.org/works"
HN_URL = "https://hn.algolia.com/api/v1/search_by_date"
ITUNES_URL = "https://itunes.apple.com/search"

NEWS_TTL = 30 * 60
MAX_ARTICLES = 500  # news; other kinds keep up to MAX_PER_KIND each
MAX_PER_KIND = 80
KINDS = ["news", "report", "science", "paper", "discussion", "podcast"]
FETCH_WORKERS = 6

# Search terms. Google News supports OR; local-language spellings are added per edition.
EN = '"El Niño" OR "El Nino"'
ES = '"El Niño" OR "fenómeno de El Niño"'
PT = '"El Niño" OR "fenômeno El Niño"'

# Google News editions: country, language, hl, gl, ceid, query, impacts slug
GOOGLE_NEWS_EDITIONS = [
    # South Asia
    ("India", "English", "en-IN", "IN", "IN:en", EN, "india"),
    ("India", "Hindi", "hi", "IN", "IN:hi", '"अल नीनो" OR "El Nino"', "india"),
    ("Pakistan", "English", "en-PK", "PK", "PK:en", EN, "pakistan"),
    ("Bangladesh", "Bengali", "bn", "BD", "BD:bn", '"এল নিনো" OR "El Nino"', "bangladesh"),
    # Southeast & East Asia
    ("Indonesia", "Indonesian", "id", "ID", "ID:id", '"El Nino" OR "El Niño"', "indonesia"),
    ("Malaysia", "English", "en-MY", "MY", "MY:en", EN, "malaysia"),
    ("Philippines", "English", "en-PH", "PH", "PH:en", EN, "philippines"),
    ("Singapore", "English", "en-SG", "SG", "SG:en", EN, None),
    ("Thailand", "Thai", "th", "TH", "TH:th", '"เอลนีโญ" OR "El Nino"', "thailand"),
    ("Vietnam", "Vietnamese", "vi", "VN", "VN:vi", '"El Nino" OR "El Niño"', "vietnam"),
    ("Japan", "Japanese", "ja", "JP", "JP:ja", "エルニーニョ", "japan"),
    ("South Korea", "Korean", "ko", "KR", "KR:ko", '"엘니뇨" OR "El Nino"', "south-korea"),
    ("Taiwan", "Chinese", "zh-TW", "TW", "TW:zh-Hant", '"聖嬰" OR "厄爾尼諾" OR "El Niño"', "taiwan"),
    ("Hong Kong", "Chinese", "zh-HK", "HK", "HK:zh-Hant", '"厄爾尼諾" OR "聖嬰" OR "El Niño"', "china"),
    # Oceania
    ("Australia", "English", "en-AU", "AU", "AU:en", EN, "australia"),
    ("New Zealand", "English", "en-NZ", "NZ", "NZ:en", EN, "new-zealand"),
    # Americas
    ("United States", "English", "en-US", "US", "US:en", EN, "united-states"),
    ("United States", "Spanish", "es-419", "US", "US:es-419", ES, "united-states"),
    ("Canada", "English", "en-CA", "CA", "CA:en", EN, "canada"),
    ("Mexico", "Spanish", "es-419", "MX", "MX:es-419", ES, "mexico"),
    ("Peru", "Spanish", "es-419", "PE", "PE:es-419", ES + ' OR "Niño costero"', "peru"),
    ("Colombia", "Spanish", "es-419", "CO", "CO:es-419", ES, "colombia"),
    ("Chile", "Spanish", "es-419", "CL", "CL:es-419", ES, "chile"),
    ("Argentina", "Spanish", "es-419", "AR", "AR:es-419", ES, "argentina"),
    ("Brazil", "Portuguese", "pt-BR", "BR", "BR:pt-419", PT, "brazil"),
    # Africa & Middle East
    ("South Africa", "English", "en-ZA", "ZA", "ZA:en", EN, "south-africa"),
    ("Kenya", "English", "en-KE", "KE", "KE:en", EN, "kenya"),
    ("Nigeria", "English", "en-NG", "NG", "NG:en", EN, None),
    ("Zimbabwe", "English", "en-ZW", "ZW", "ZW:en", EN, "zimbabwe"),
    ("Egypt", "Arabic", "ar", "EG", "EG:ar", '"النينيو" OR "El Nino"', None),
    # Europe
    ("United Kingdom", "English", "en-GB", "GB", "GB:en", EN, None),
    ("France", "French", "fr", "FR", "FR:fr", '"El Niño" OR "El Nino"', None),
    ("Germany", "German", "de", "DE", "DE:de", '"El Niño" OR "El Nino"', None),
    ("Spain", "Spanish", "es", "ES", "ES:es", ES, None),
    ("Italy", "Italian", "it", "IT", "IT:it", '"El Niño" OR "El Nino"', None),
]

# Worldwide searches for each impact theme (English, global edition).
THEME_QUERIES = [
    ("drought", '"El Niño" (drought OR wildfire OR haze)'),
    ("floods", '"El Niño" (flood OR floods OR landslide OR "heavy rain")'),
    ("heat", '"El Niño" ("global temperature" OR heatwave OR "hottest year" OR record heat)'),
    ("food", '"El Niño" (crop OR harvest OR rice OR wheat OR cocoa OR coffee OR "palm oil" OR "food prices")'),
    ("health", '"El Niño" (dengue OR malaria OR cholera OR disease OR hunger)'),
    ("oceans", '"El Niño" (coral OR bleaching OR fisheries OR anchovy OR "marine heatwave")'),
    ("economy", '"El Niño" (economy OR inflation OR hydropower OR electricity OR shipping OR "Panama Canal")'),
    ("storms", '"El Niño" (hurricane OR typhoon OR cyclone)'),
    ("forecast", '"El Niño" (forecast OR outlook OR NOAA OR WMO OR advisory)'),
]

# Crop searches (English worldwide edition + India in Hindi), tagged "food" and the crop.
CROP_QUERIES = [
    ("rice", '"El Niño" (rice OR paddy)'),
    ("wheat", '"El Niño" wheat'),
    ("maize", '"El Niño" (maize OR corn)'),
    ("sugar", '"El Niño" (sugar OR sugarcane)'),
    ("soybeans", '"El Niño" (soybean OR soybeans OR soy)'),
    ("coffee", '"El Niño" coffee'),
    ("cocoa", '"El Niño" cocoa'),
    ("palm-oil", '"El Niño" "palm oil"'),
    ("cotton", '"El Niño" cotton'),
]
CROP_QUERIES_HI = '("अल नीनो" OR "El Nino") (फसल OR गन्ना OR चीनी OR धान OR गेहूं OR कपास)'

# YouTube channels of weather/climate agencies. The channel ID is looked up
# from the handle; the fallback ID is used if that lookup fails.
# Bing News markets: (market, country, language, impacts slug or None, query)
BING_MARKETS = [
    ("en-US", None, "English", None, '"El Nino" OR "El Niño"'),
    ("en-GB", "United Kingdom", "English", None, '"El Nino" OR "El Niño"'),
    ("en-IN", "India", "English", "india", '"El Nino" monsoon OR farmers OR rain'),
    ("en-AU", "Australia", "English", "australia", '"El Nino" BOM OR drought OR rain'),
    ("en-PH", "Philippines", "English", "philippines", '"El Nino" PAGASA OR drought'),
    ("en-ZA", "South Africa", "English", "south-africa", '"El Nino" drought OR rain'),
    ("es-MX", "Mexico", "Spanish", "mexico", '"El Niño" lluvias OR sequía'),
    ("es-ES", None, "Spanish", None, '"El Niño" fenómeno'),
    ("pt-BR", "Brazil", "Portuguese", "brazil", '"El Niño" chuva OR seca'),
    ("fr-FR", None, "French", None, '"El Niño" climat'),
    ("de-DE", None, "German", None, '"El Niño" Klima'),
    ("ja-JP", "Japan", "Japanese", "japan", "エルニーニョ"),
]

# Agency and science feeds (RSS/Atom). Only El Niño / ENSO items are kept.
# (name, url, kind, home page)
FEEDS = [
    ("NOAA Climate.gov ENSO blog", "https://www.climate.gov/feeds/news-features/enso.rss", "science", "https://www.climate.gov/enso"),
    ("NASA Earth Observatory", "https://earthobservatory.nasa.gov/feeds/earth-observatory.rss", "science", "https://earthobservatory.nasa.gov/"),
    ("UN News: climate", "https://news.un.org/feed/subscribe/en/news/topic/climate-change/feed/rss.xml", "news", "https://news.un.org/"),
    ("Carbon Brief", "https://www.carbonbrief.org/feed/", "science", "https://www.carbonbrief.org/"),
    ("Phys.org Earth", "https://phys.org/rss-feed/earth-news/", "science", "https://phys.org/earth-news/"),
    ("ScienceDaily: climate", "https://www.sciencedaily.com/rss/earth_climate/climate.xml", "science", "https://www.sciencedaily.com/"),
    ("ScienceDaily: weather", "https://www.sciencedaily.com/rss/earth_climate/weather.xml", "science", "https://www.sciencedaily.com/"),
]

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


GDELT_RETRY_DELAYS = (6, 15)  # GDELT allows about one request per 5 seconds per address


def fetch_gdelt() -> list[dict[str, Any]]:
    params = {
        "query": GDELT_QUERY, "mode": "artlist", "format": "json",
        "maxrecords": 100, "sort": "datedesc", "timespan": "7d",
    }
    for delay in (*GDELT_RETRY_DELAYS, None):
        try:
            data = services._get_json(GDELT_URL, params)
            return parse_gdelt(data if isinstance(data, dict) else {})
        except services.UpstreamError as exc:
            if not exc.rate_limited or delay is None:
                raise
            log.info("GDELT rate limit, retrying in %s s", delay)
            time.sleep(delay)
    return []


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
    country, language, hl, gl, ceid, query, slug = edition
    url = GOOGLE_NEWS_URL.format(q=quote_plus(query), hl=hl, gl=gl, ceid=ceid)
    articles = parse_google_news(services._get_text(url), country, language)
    for a in articles:
        a["edition"] = slug
    return articles


def fetch_crop_news(crop_id: str, query: str, hl="en-US", gl="US", ceid="US:en", country=None,
                    language="English", edition=None) -> list[dict[str, Any]]:
    url = GOOGLE_NEWS_URL.format(q=quote_plus(query), hl=hl, gl=gl, ceid=ceid)
    articles = parse_google_news(services._get_text(url), country, language)
    for a in articles:
        a["theme_hint"] = "food"
        if crop_id:
            a["crop_hint"] = crop_id
        if edition:
            a["edition"] = edition
    return articles


def fetch_theme_news(theme_id: str, query: str) -> list[dict[str, Any]]:
    url = GOOGLE_NEWS_URL.format(q=quote_plus(query), hl="en-US", gl="US", ceid="US:en")
    articles = parse_google_news(services._get_text(url), None, "English")
    for a in articles:
        a["theme_hint"] = theme_id
    return articles


# --------------------------------------------------------------------------
# Generic RSS / Atom feeds (Bing News, ReliefWeb, agencies, arXiv)
# --------------------------------------------------------------------------

_TAG = re.compile(r"<[^>]+>")


def _text(value: str | None, limit: int = 300) -> str:
    text = re.sub(r"\s+", " ", _TAG.sub(" ", value or "")).strip()
    return text if len(text) <= limit else text[: limit - 1].rsplit(" ", 1)[0] + "…"


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child(el: ET.Element, *names: str) -> ET.Element | None:
    for child in el:
        if _local(child.tag) in names:
            return child
    return None


def _date(value: str | None) -> dt.datetime | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        pass
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_feed(xml: str, source: str, kind: str, via: str, topic_only: bool = True,
               country: str | None = None, language: str | None = "English") -> list[dict[str, Any]]:
    """Items from an RSS 2.0 or Atom feed. With topic_only, keep El Niño / ENSO items."""
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        # Some feeds have bare "&" or HTML entities; fix those and try once more.
        fixed = re.sub(r"&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)", "&amp;", xml)
        root = ET.fromstring(fixed)
    items = [el for el in root.iter() if _local(el.tag) in ("item", "entry")]
    out = []
    for item in items:
        title_el = _child(item, "title")
        title = _text(title_el.text if title_el is not None else "", 400)
        link_el = _child(item, "link")
        link = None
        if link_el is not None:
            link = link_el.get("href") or link_el.text
        if not link:
            id_el = _child(item, "id", "guid")
            link = id_el.text if id_el is not None else None
        url = _safe_url(link)
        summary_el = _child(item, "description", "summary", "content")
        summary = _text(summary_el.text if summary_el is not None else "")
        if not url or not title or (topic_only and not TOPIC.search(f"{title} {summary}")):
            continue
        # Bing wraps links: .../apiclick.aspx?...&url=<real link>
        if "bing.com" in urlparse(url).netloc:
            real = parse_qs(urlparse(url).query).get("url")
            url = _safe_url(real[0]) if real else url
            if not url:
                continue
        date_el = _child(item, "pubDate", "published", "updated", "date")
        src_el = _child(item, "Source", "source")
        image_el = _child(item, "Image")
        image = _safe_url(image_el.text if image_el is not None else None)
        out.append({
            "title": title,
            "url": url,
            "source": _text(src_el.text, 80) if src_el is not None and src_el.text else source,
            "country": country,
            "language": language,
            "published": _iso(_date(date_el.text if date_el is not None else None)),
            "image": image if image and image.startswith("https://") else None,
            "via": via,
            "kind": kind,
            "summary": summary or None,
        })
    return out


def fetch_bing_news(market: tuple) -> list[dict[str, Any]]:
    mkt, country, language, slug, query = market
    items = parse_feed(services._get_text(BING_NEWS_URL.format(q=quote_plus(query), mkt=mkt)), "Bing News",
                       "news", "Bing News", topic_only=False, country=country, language=language)
    for a in items:
        if slug:
            a["edition"] = slug
    return items


def fetch_reports() -> list[dict[str, Any]]:
    url = GOOGLE_NEWS_URL.format(q=quote_plus(REPORTS_QUERY), hl="en-US", gl="US", ceid="US:en")
    items = parse_google_news(services._get_text(url), None, "English")
    for a in items:
        a["kind"] = "report"
    return items


def fetch_feed(feed: tuple) -> list[dict[str, Any]]:
    name, url, kind, _home = feed
    return parse_feed(services._get_text(url), name, kind, name)


def fetch_arxiv() -> list[dict[str, Any]]:
    items = parse_feed(services._get_text(ARXIV_URL), "arXiv", "paper", "arXiv")
    for a in items:
        a["image"] = None
    return items


def parse_crossref(data: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for w in (data.get("message") or {}).get("items") or []:
        title = _text(" ".join(w.get("title") or []), 400)
        url = _safe_url(w.get("URL"))
        if not title or not url or not TOPIC.search(title):
            continue
        parts = ((w.get("published") or w.get("issued") or {}).get("date-parts") or [[None]])[0]
        published = None
        if parts and parts[0]:
            published = dt.datetime(parts[0], (parts[1] if len(parts) > 1 else 1) or 1,
                                    (parts[2] if len(parts) > 2 else 1) or 1, tzinfo=dt.timezone.utc)
        journal = " ".join(w.get("container-title") or []) or w.get("publisher") or "Crossref"
        out.append({"title": title, "url": url, "source": _text(journal, 80), "country": None, "language": "English",
                    "published": _iso(published), "image": None, "via": "Crossref", "kind": "paper", "summary": None})
    return out


def fetch_crossref(today: dt.date | None = None) -> list[dict[str, Any]]:
    today = today or dt.datetime.now(dt.timezone.utc).date()
    params = {"query.bibliographic": "El Nino ENSO", "sort": "published", "order": "desc", "rows": 40,
              "filter": f"from-pub-date:{today - dt.timedelta(days=365)},until-pub-date:{today},type:journal-article",
              "select": "title,URL,published,issued,container-title,publisher"}
    return parse_crossref(services._get_json(CROSSREF_URL, params))


def parse_hn(data: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for h in data.get("hits") or []:
        title = _text(h.get("title"), 300)
        if not title or not TOPIC.search(title):
            continue
        discussion = f"https://news.ycombinator.com/item?id={h.get('objectID')}"
        comments = h.get("num_comments") or 0
        out.append({"title": title, "url": _safe_url(h.get("url")) or discussion, "source": f"Hacker News · {comments} comments",
                    "country": None, "language": "English", "published": _iso(_date(h.get("created_at"))),
                    "image": None, "via": "Hacker News", "kind": "discussion", "summary": None, "discussion": discussion})
    return out


def fetch_hn() -> list[dict[str, Any]]:
    return parse_hn(services._get_json(HN_URL, {"query": "El Nino", "tags": "story", "hitsPerPage": 40}))


def parse_podcasts(data: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for r in data.get("results") or []:
        title = _text(r.get("trackName"), 300)
        url = _safe_url(r.get("trackViewUrl"))
        if not title or not url or not TOPIC.search(f"{title} {r.get('description') or ''}"):
            continue
        image = _safe_url(r.get("artworkUrl160") or r.get("artworkUrl600"))
        out.append({"title": title, "url": url, "source": _text(r.get("collectionName"), 80) or "Podcast",
                    "country": None, "language": None, "published": _iso(_date(r.get("releaseDate"))),
                    "image": image if image and image.startswith("https://") else None,
                    "via": "Apple Podcasts", "kind": "podcast", "summary": _text(r.get("description"), 240) or None})
    return out


def fetch_podcasts() -> list[dict[str, Any]]:
    return parse_podcasts(services._get_json(ITUNES_URL, {"term": "El Nino", "media": "podcast",
                                                          "entity": "podcastEpisode", "limit": 50}))


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


def tag_article(article: dict[str, Any]) -> dict[str, Any]:
    """Add impact themes and the countries the headline is about."""
    text = article["title"]
    themes = impacts.classify_themes(text)
    hint = article.pop("theme_hint", None)
    if hint and hint not in themes:
        themes.append(hint)
    countries = impacts.detect_countries(text)
    edition = article.pop("edition", None)
    if edition and edition not in countries:
        countries.append(edition)
    found_crops = crops.detect_crops(text)
    crop_hint = article.pop("crop_hint", None)
    if crop_hint and crop_hint not in found_crops:
        found_crops.append(crop_hint)
    if found_crops and "food" not in themes:
        themes.append("food")
    article.setdefault("kind", "news")
    article["themes"] = themes
    article["countries"] = countries
    article["crops"] = found_crops
    return article


def merge_articles(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for group in groups:
        for article in group:
            article = tag_article(dict(article))
            key = _title_key(article["title"])
            if not key:
                continue
            if key not in seen:
                seen[key] = article
                continue
            kept = seen[key]
            if not kept.get("image") and article.get("image"):
                kept["image"] = article["image"]
            kept["themes"] = list(dict.fromkeys(kept["themes"] + article["themes"]))
            kept["countries"] = list(dict.fromkeys(kept["countries"] + article["countries"]))
            kept["crops"] = list(dict.fromkeys(kept["crops"] + article["crops"]))
            if not kept.get("country") and article.get("country"):
                kept["country"] = article["country"]
    articles = sorted(seen.values(), key=lambda a: a["published"] or "", reverse=True)
    counts: dict[str, int] = {}
    kept_articles = []
    for a in articles:
        n = counts[a["kind"]] = counts.get(a["kind"], 0) + 1
        if n <= (MAX_ARTICLES if a["kind"] == "news" else MAX_PER_KIND):
            kept_articles.append(a)
    return kept_articles


def get_news() -> dict[str, Any]:
    def build() -> dict[str, Any]:
        sources, videos = [], []

        def run(name: str, kind: str, url: str, fn):
            try:
                items = fn()
                sources.append({"name": name, "kind": kind, "url": url, "ok": True, "count": len(items)})
                return items
            except (services.UpstreamError, ET.ParseError, KeyError, TypeError, ValueError, AttributeError) as exc:
                log.warning("News source %s failed: %s", name, exc)
                sources.append({"name": name, "kind": kind, "url": url, "ok": False, "count": 0})
                return []

        jobs = [("GDELT global news", "news", "https://www.gdeltproject.org/", fetch_gdelt)]
        for e in GOOGLE_NEWS_EDITIONS:
            jobs.append((f"Google News {e[0]} ({e[1]})", "news", "https://news.google.com/",
                         lambda e=e: fetch_google_news(e)))
        for theme_id, query in THEME_QUERIES:
            jobs.append((f"Google News worldwide: {theme_id}", "news", "https://news.google.com/",
                         lambda t=theme_id, q=query: fetch_theme_news(t, q)))
        for crop_id, query in CROP_QUERIES:
            jobs.append((f"Google News crops: {crop_id}", "news", "https://news.google.com/",
                         lambda c=crop_id, q=query: fetch_crop_news(c, q)))
        jobs.append(("Google News crops: India (Hindi)", "news", "https://news.google.com/",
                     lambda: fetch_crop_news(None, CROP_QUERIES_HI, "hi", "IN", "IN:hi", "India", "Hindi", "india")))
        for m in BING_MARKETS:
            jobs.append((f"Bing News {m[1] or m[0]} ({m[2]})", "news", "https://www.bing.com/news",
                         lambda m=m: fetch_bing_news(m)))
        jobs.append(("Humanitarian reports (ReliefWeb, FAO, WFP, OCHA, IFRC, UNICEF, FEWS NET)", "report",
                     "https://reliefweb.int/", fetch_reports))
        for f in FEEDS:
            jobs.append((f[0], f[2], f[3], lambda f=f: fetch_feed(f)))
        jobs.append(("arXiv research papers", "paper", "https://arxiv.org/", fetch_arxiv))
        jobs.append(("Crossref journal articles", "paper", "https://www.crossref.org/", fetch_crossref))
        jobs.append(("Hacker News discussions", "discussion", "https://news.ycombinator.com/", fetch_hn))
        jobs.append(("Apple Podcasts episodes", "podcast", "https://podcasts.apple.com/", fetch_podcasts))
        video_jobs = [(f"YouTube: {c['name']}", "video", YOUTUBE_HANDLE_URL.format(handle=c["handle"]),
                       lambda c=c: fetch_channel_videos(c)) for c in YOUTUBE_CHANNELS]

        # Fetch in parallel (GDELT retries with pauses, so it runs alongside the rest).
        with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
            news_results = list(pool.map(lambda j: run(*j), jobs))
            video_results = list(pool.map(lambda j: run(*j), video_jobs))
        groups = news_results
        for items in video_results:
            videos += items

        articles = merge_articles(groups)
        if not articles and not any(s["ok"] for s in sources if s["kind"] != "video"):
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
