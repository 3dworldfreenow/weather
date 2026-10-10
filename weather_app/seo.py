"""Search-engine and sharing metadata: page text, FAQ, JSON-LD, sitemap, robots, manifest."""

from __future__ import annotations

import datetime as dt
import json
from typing import Any

SITE_NAME = "El Niño Tracker"
TITLE = "El Niño Tracker – Live El Niño Status, Pacific Sea Temperatures & News"
DESCRIPTION = (
    "Is El Niño happening now? Live El Niño and La Niña status from NOAA data, Niño 3.4 "
    "sea temperature anomalies, where the Pacific is warming, a live satellite globe, and "
    "El Niño news and videos from around the world. Free, updated every 30 minutes."
)
KEYWORDS = (
    "El Niño, El Nino, La Niña, ENSO, El Niño 2026, El Niño update, Niño 3.4, Oceanic Niño Index, "
    "sea surface temperature anomaly, Pacific Ocean temperature, El Niño news, El Niño monsoon India, "
    "El Niño tracker, NOAA ENSO"
)
THEME_COLOR = "#12161e"

# Plain-language answers shown in the Learn panel and published as FAQ structured data.
FAQ = [
    {
        "q": "What is El Niño?",
        "a": "El Niño is the warm phase of the El Niño–Southern Oscillation (ENSO), a natural climate "
             "pattern in the tropical Pacific Ocean. During El Niño, sea surface temperatures in the "
             "central and eastern equatorial Pacific become warmer than normal, the trade winds weaken, "
             "and rainfall shifts eastward. It typically develops every 2 to 7 years and usually lasts "
             "9 to 12 months, sometimes longer.",
    },
    {
        "q": "What is La Niña?",
        "a": "La Niña is the cool phase of ENSO, the opposite of El Niño. Sea surface temperatures in the "
             "central and eastern equatorial Pacific are cooler than normal and the trade winds are "
             "stronger. When neither is present, conditions are called ENSO-neutral.",
    },
    {
        "q": "How is El Niño measured?",
        "a": "Scientists watch the sea surface temperature anomaly (the difference from the long-term "
             "average) in the Niño 3.4 region, from 5°N to 5°S and 170°W to 120°W. NOAA's Oceanic Niño "
             "Index (ONI) is the 3-month average of that anomaly. A value of +0.5 °C or more points to "
             "El Niño conditions and −0.5 °C or less to La Niña conditions. NOAA also checks the "
             "atmosphere, such as winds and rainfall, before declaring an event.",
    },
    {
        "q": "What are the Niño regions?",
        "a": "There are four standard monitoring boxes along the equatorial Pacific: Niño 1+2 off the "
             "coast of Ecuador and Peru, Niño 3 in the eastern Pacific, Niño 3.4 in the central-east "
             "Pacific (the main index), and Niño 4 in the central-west Pacific. Warming that starts in "
             "Niño 1+2 is often called a coastal El Niño.",
    },
    {
        "q": "How does El Niño affect India's monsoon?",
        "a": "El Niño years often bring a weaker Indian summer monsoon with below-normal rainfall and a "
             "higher risk of drought, but not always: other factors such as the Indian Ocean Dipole also "
             "matter. The India Meteorological Department (IMD) issues the official monsoon forecasts.",
    },
    {
        "q": "How does El Niño affect the rest of the world?",
        "a": "Typical El Niño effects include drier conditions in Indonesia, Australia, southern Africa and "
             "parts of South and Southeast Asia; heavy rain and flooding in coastal Peru and Ecuador; "
             "a wetter winter in the southern United States; fewer Atlantic hurricanes and more central "
             "and eastern Pacific storms; and a boost to global average temperature. Effects vary from "
             "event to event.",
    },
    {
        "q": "Is El Niño happening right now?",
        "a": "This tracker shows the latest weekly Niño 3.4 anomaly from NOAA, whether the Pacific is "
             "warming or cooling over the last four weeks, and which Niño region is warmest. For the "
             "official status, see NOAA's monthly ENSO diagnostic discussion.",
    },
    {
        "q": "Where does this data come from?",
        "a": "Niño indices come from NOAA's Climate Prediction Center, the sea temperature anomaly map from "
             "the GHRSST MUR analysis via NASA GIBS, live satellite images from NOAA (GOES), EUMETSAT "
             "(Meteosat) and JMA (Himawari), and news from GDELT and Google News. All sources are free "
             "and public.",
    },
]


def site_url(configured: str | None, fallback: str) -> str:
    url = (configured or fallback or "/").strip()
    return url if url.endswith("/") else url + "/"


def page_meta(base_url: str) -> dict[str, Any]:
    return {
        "site_name": SITE_NAME,
        "title": TITLE,
        "description": DESCRIPTION,
        "keywords": KEYWORDS,
        "url": base_url,
        "image": base_url + "static/img/og-image.png",
        "theme_color": THEME_COLOR,
    }


def json_ld(base_url: str, enso: dict[str, Any] | None = None) -> str:
    """Structured data: the web app, the FAQ, and the El Niño dataset."""
    graph: list[dict[str, Any]] = [
        {
            "@type": "WebSite",
            "@id": base_url + "#website",
            "url": base_url,
            "name": SITE_NAME,
            "description": DESCRIPTION,
            "inLanguage": "en",
        },
        {
            "@type": "WebApplication",
            "name": SITE_NAME,
            "url": base_url,
            "applicationCategory": "EducationalApplication",
            "operatingSystem": "Any (web browser)",
            "isAccessibleForFree": True,
            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
            "description": DESCRIPTION,
            "image": base_url + "static/img/og-image.png",
        },
        {
            "@type": "FAQPage",
            "mainEntity": [
                {"@type": "Question", "name": item["q"],
                 "acceptedAnswer": {"@type": "Answer", "text": item["a"]}}
                for item in FAQ
            ],
        },
    ]
    dataset: dict[str, Any] = {
        "@type": "Dataset",
        "name": "Live El Niño (ENSO) indicators",
        "description": "Weekly sea surface temperature anomalies for the Niño 1+2, 3, 3.4 and 4 regions and "
                       "the Oceanic Niño Index, from NOAA's Climate Prediction Center, with a daily sea "
                       "surface temperature anomaly map.",
        "url": base_url,
        "isAccessibleForFree": True,
        "keywords": ["El Niño", "La Niña", "ENSO", "Niño 3.4", "sea surface temperature anomaly"],
        "creator": {"@type": "Organization", "name": "NOAA Climate Prediction Center",
                    "url": "https://www.cpc.ncep.noaa.gov/"},
        "spatialCoverage": {"@type": "Place", "name": "Equatorial Pacific Ocean"},
        "variableMeasured": "Sea surface temperature anomaly (°C)",
    }
    if enso and enso.get("week"):
        dataset["temporalCoverage"] = f"../{enso['week']}"
        dataset["dateModified"] = enso["week"]
    graph.append(dataset)
    return json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)


def sitemap(base_url: str, lastmod: dt.date | None = None) -> str:
    day = (lastmod or dt.datetime.now(dt.timezone.utc).date()).isoformat()
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"  <url><loc>{base_url}</loc><lastmod>{day}</lastmod>"
        "<changefreq>hourly</changefreq><priority>1.0</priority></url>\n"
        "</urlset>\n"
    )


def robots(base_url: str) -> str:
    return f"User-agent: *\nAllow: /\n\nSitemap: {base_url}sitemap.xml\n"


def manifest() -> dict[str, Any]:
    return {
        "name": SITE_NAME,
        "short_name": "El Niño",
        "description": DESCRIPTION,
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": THEME_COLOR,
        "theme_color": THEME_COLOR,
        "icons": [
            {"src": "static/img/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "static/img/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
        ],
    }
