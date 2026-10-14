"""Grow weather_app/data/news_feeds.csv from open data, keeping only feeds that work.

Sources (both free to reuse):
* Wikidata (CC0): every newspaper, news agency, TV or radio broadcaster, university,
  research institute, government body and weather service that lists a web feed
  (property P1019), with its country and language.
* plenaryapp/awesome-rss-feeds on GitHub: news feeds grouped by country (OPML).

Every candidate feed is downloaded and must be a valid RSS/Atom feed with at least
one item, and its newest item must be under a year old. The hand-picked rows at the
top of the CSV are kept as they are; everything below the IMPORT_MARKER line is
regenerated. Runs weekly in .github/workflows/update-feeds.yml.

    python scripts/import_feeds.py [--max 10000]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import logging
import re
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from weather_app import impacts, news, services  # noqa: E402

log = logging.getLogger("import_feeds")

CSV_PATH = news.FEEDS_CSV
IMPORT_MARKER = "# ==== imported by scripts/import_feeds.py: do not edit below, add hand-picked feeds above ===="
FIELDS = ["country", "slug", "language", "publisher", "url", "type", "category", "filter", "origin"]

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
WIKIDATA_QUERY = """
SELECT ?item ?itemLabel ?feed ?countryLabel ?langLabel ?typeLabel WHERE {
  ?item wdt:P1019 ?feed .
  OPTIONAL { ?item wdt:P17 ?country . }
  OPTIONAL { ?item wdt:P407 ?lang . }
  OPTIONAL { ?item wdt:P31 ?type . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
"""
AWESOME_API = "https://api.github.com/repos/plenaryapp/awesome-rss-feeds/contents/countries/with_category"

# Wikidata "instance of" labels -> our feed category (first match wins). Anything else
# (companies, blogs, software, sports clubs …) is skipped.
CATEGORY_RULES = [
    ("weather", r"meteorolog|weather service|weather forecast"),
    ("university", r"universit|college|research institute|research center|research centre|academy of sciences"
                   r"|institute of technology|polytechnic|observatory"),
    ("government", r"government|ministry|ministerial|department of|public body|public agency|state agency"
                   r"|federal agency|national agency|regulator|parliament|legislature|space agency|municipal"),
    ("tv", r"television|tv channel|broadcast|radio station|radio network|radio channel|public service media"),
    ("newspaper", r"newspaper|news agency|news website|news media|news magazine|online newspaper|news outlet"
                  r"|newsroom|daily|weekly magazine|press agency"),
]
CATEGORY_RE = [(cat, re.compile(rx, re.IGNORECASE)) for cat, rx in CATEGORY_RULES]

LANG_CODES = {
    "en": "English", "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "te": "Telugu", "mr": "Marathi", "gu": "Gujarati",
    "kn": "Kannada", "ml": "Malayalam", "pa": "Punjabi", "ur": "Urdu", "ne": "Nepali", "si": "Sinhala", "es": "Spanish",
    "pt": "Portuguese", "fr": "French", "de": "German", "it": "Italian", "nl": "Dutch", "ru": "Russian", "uk": "Ukrainian",
    "pl": "Polish", "tr": "Turkish", "ar": "Arabic", "fa": "Persian", "he": "Hebrew", "zh": "Chinese", "ja": "Japanese",
    "ko": "Korean", "id": "Indonesian", "ms": "Malay", "th": "Thai", "vi": "Vietnamese", "tl": "Filipino", "sw": "Swahili",
    "am": "Amharic", "so": "Somali", "ha": "Hausa", "yo": "Yoruba", "af": "Afrikaans", "el": "Greek", "sv": "Swedish",
    "no": "Norwegian", "nb": "Norwegian", "da": "Danish", "fi": "Finnish", "cs": "Czech", "sk": "Slovak", "hu": "Hungarian",
    "ro": "Romanian", "bg": "Bulgarian", "sr": "Serbian", "hr": "Croatian", "ca": "Catalan", "eu": "Basque", "gl": "Galician",
    "my": "Burmese", "km": "Khmer", "lo": "Lao", "mn": "Mongolian", "kk": "Kazakh", "uz": "Uzbek", "az": "Azerbaijani",
}


def country_slugs() -> dict[str, str]:
    """Country name (lower case) -> impacts slug, for the countries the site covers."""
    names = {}
    for c in impacts.COUNTRIES:
        names[c["name"].lower()] = c["slug"]
    names.update({"united states of america": "united-states", "people's republic of china": "china",
                  "republic of the congo": "", "south korea": "south-korea", "republic of korea": "south-korea",
                  "taiwan": "taiwan", "east timor": "timor-leste", "kingdom of eswatini": "eswatini", "swaziland": "eswatini"})
    return names


def norm_url(url: str) -> str:
    u = urlparse(url.strip())
    return f"{u.netloc.lower().removeprefix('www.')}{u.path.rstrip('/')}?{u.query}"


def classify(type_labels: list[str]) -> str | None:
    text = " | ".join(type_labels)
    for cat, rx in CATEGORY_RE:
        if rx.search(text):
            return cat
    return None


# --------------------------------------------------------------------------
# Candidate sources
# --------------------------------------------------------------------------

def from_wikidata(session: requests.Session) -> list[dict[str, str]]:
    resp = session.get(WIKIDATA_SPARQL, params={"query": WIKIDATA_QUERY, "format": "json"}, timeout=300,
                       headers={"Accept": "application/sparql-results+json"})
    resp.raise_for_status()
    by_feed: dict[str, dict] = {}
    for b in resp.json()["results"]["bindings"]:
        url = b["feed"]["value"]
        if not url.startswith(("http://", "https://")):
            continue
        row = by_feed.setdefault(url, {"name": b.get("itemLabel", {}).get("value", ""), "types": set(),
                                       "country": "", "lang": ""})
        if "typeLabel" in b:
            row["types"].add(b["typeLabel"]["value"])
        if not row["country"] and "countryLabel" in b:
            row["country"] = b["countryLabel"]["value"]
        if not row["lang"] and "langLabel" in b:
            row["lang"] = b["langLabel"]["value"]
    out = []
    for url, row in by_feed.items():
        cat = classify(sorted(row["types"]))
        if not cat or not row["name"] or re.fullmatch(r"Q\d+", row["name"]):
            continue
        out.append({"country": row["country"], "language": row["lang"].capitalize() if row["lang"] else "",
                    "publisher": row["name"], "url": url, "category": cat, "origin": "wikidata"})
    log.info("Wikidata: %d feeds with a feed URL, %d news/broadcast/government/university/weather", len(by_feed), len(out))
    return out


def from_awesome(session: requests.Session) -> list[dict[str, str]]:
    files = session.get(AWESOME_API, timeout=60)
    files.raise_for_status()
    out = []
    for f in files.json():
        if not f.get("name", "").endswith(".opml") or not f.get("download_url"):
            continue
        country = f["name"][:-5].replace("_", " ").strip()
        try:
            root = ET.fromstring(session.get(f["download_url"], timeout=60).content)
        except (requests.RequestException, ET.ParseError) as exc:
            log.warning("awesome-rss-feeds %s: %s", f["name"], exc)
            continue
        for o in root.iter("outline"):
            url = o.get("xmlUrl")
            if url and url.startswith(("http://", "https://")):
                out.append({"country": country, "language": "", "publisher": o.get("title") or o.get("text") or "",
                            "url": url, "category": "newspaper", "origin": "awesome-rss-feeds"})
    log.info("awesome-rss-feeds: %d feeds", len(out))
    return out


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def check_feed(session: requests.Session, cand: dict[str, str], now: dt.datetime) -> dict[str, str] | None:
    """The candidate (with its language filled in when known) if it is a working, recent feed."""
    try:
        return _check_feed(session, cand, now)
    except Exception as exc:  # noqa: BLE001 - thousands of foreign servers: any failure just means "not working"
        log.debug("Feed %s: %s", cand["url"], exc)
        return None


def _check_feed(session: requests.Session, cand: dict[str, str], now: dt.datetime) -> dict[str, str] | None:
    try:
        resp = session.get(cand["url"], timeout=12, stream=True)
        if not resp.ok:
            return None
        body = resp.raw.read(3_000_000, decode_content=True)  # skip giant files
        text = body.decode(resp.encoding or "utf-8", errors="replace")
    except (requests.RequestException, OSError, ValueError):
        return None
    finally:
        if "resp" in locals():
            resp.close()
    if not news._looks_like_feed(text):
        return None
    try:
        items = news.parse_feed(text, cand["publisher"], "news", "x", topic_only=False)
    except (ET.ParseError, ValueError):
        return None
    if not items:
        return None
    newest = max((a["published"] for a in items if a["published"]), default=None)
    if newest and newest < (now - dt.timedelta(days=365)).isoformat():
        return None  # abandoned feed
    lang = cand.get("language") or ""
    if not lang:
        m = re.search(r"<(?:\w+:)?language>\s*([A-Za-z]{2})", text[:5000])
        lang = LANG_CODES.get(m.group(1).lower(), "") if m else ""
    return {**cand, "language": lang, "url": resp.url if resp.url.startswith("http") else cand["url"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max", type=int, default=10000, help="most imported feeds to keep")
    parser.add_argument("--workers", type=int, default=48)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    session = requests.Session()
    session.headers["User-Agent"] = services.USER_AGENT
    session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64))
    session.mount("http://", requests.adapters.HTTPAdapter(pool_connections=64, pool_maxsize=64))

    raw = CSV_PATH.read_text(encoding="utf-8")
    curated_text = raw.split(IMPORT_MARKER)[0].rstrip("\n")
    lines = curated_text.splitlines()
    if lines and lines[0].startswith("country,") and "origin" not in lines[0]:
        lines[0] = ",".join(FIELDS)
    curated_text = "\n".join(lines)
    curated = list(csv.DictReader(io.StringIO(curated_text)))
    seen = {norm_url(r["url"]) for r in curated if r.get("url")}

    candidates: list[dict[str, str]] = []
    for name, fn in (("Wikidata", from_wikidata), ("awesome-rss-feeds", from_awesome)):
        try:
            candidates += fn(session)
        except (requests.RequestException, ValueError, KeyError) as exc:
            log.warning("%s could not be read: %s", name, exc)
    unique = []
    for c in candidates:
        key = norm_url(c["url"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    log.info("%d new candidate feeds to check", len(unique))

    now = dt.datetime.now(dt.timezone.utc)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        checked = list(pool.map(lambda c: check_feed(session, c, now), unique))
    good = [c for c in checked if c]
    log.info("%d of %d feeds work", len(good), len(unique))

    slugs = country_slugs()
    order = {"newspaper": 0, "tv": 1, "government": 2, "weather": 3, "university": 4}
    rows, final_seen = [], set()
    for c in sorted(good, key=lambda c: (order[c["category"]], c["country"] or "~", c["publisher"].lower())):
        key = norm_url(c["url"])
        if key in final_seen:
            continue  # redirected to a feed we already have
        final_seen.add(key)
        rows.append({
            "country": c["country"], "slug": slugs.get(c["country"].lower(), ""), "language": c["language"],
            "publisher": c["publisher"].strip()[:120], "url": c["url"], "type": "feed", "category": c["category"],
            "filter": "all" if c["category"] == "weather" else "topic", "origin": c["origin"],
        })
    rows = rows[: args.max]

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=FIELDS, lineterminator="\n")
    writer.writerows(rows)
    CSV_PATH.write_text(f"{curated_text}\n{IMPORT_MARKER}\n{out.getvalue()}", encoding="utf-8")
    by_cat: dict[str, int] = {}
    for r in rows:
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
    log.info("Wrote %d imported feeds (%s) from %d countries to %s", len(rows),
             ", ".join(f"{k}: {v}" for k, v in sorted(by_cat.items())), len({r['country'] for r in rows}), CSV_PATH)


if __name__ == "__main__":
    main()
