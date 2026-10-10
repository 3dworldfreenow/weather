"""El Niño / La Niña (ENSO) monitoring.

Sources (all free, no key):
* NOAA CPC weekly sea surface temperatures and anomalies for the Niño regions
  https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for
* NOAA CPC Oceanic Niño Index (ONI), the official 3-month ENSO index
  https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt
* NASA GIBS daily GHRSST MUR sea surface temperature anomaly map tiles
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from . import satellites, services

WEEKLY_URL = "https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for"
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
CPC_DISCUSSION_URL = ("https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/"
                      "enso_advisory/ensodisc.shtml")

SST_ANOMALY_PATTERNS = [
    r"^GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies$",
    r"Sea_Surface_Temperature_Anomal",
]
SST_ANOMALY_FALLBACK = {
    "layer": "GHRSST_L4_MUR_Sea_Surface_Temperature_Anomalies",
    "matrix_set": "GoogleMapsCompatible_Level7",
    "ext": "png",
}
# MUR analyses are published about one day after the date they describe.
SST_LATENCY_DAYS = 2

# Official Niño monitoring regions. Longitudes are continuous across the
# date line (Niño 4 spans 160°E-150°W) so they draw as single boxes.
REGIONS = [
    {"id": "nino12", "name": "Niño 1+2", "south": -10, "north": 0, "west": -90, "east": -80,
     "about": "Coast of Ecuador and Peru. Warms first in 'coastal El Niño' events."},
    {"id": "nino3", "name": "Niño 3", "south": -5, "north": 5, "west": -150, "east": -90,
     "about": "Eastern equatorial Pacific."},
    {"id": "nino34", "name": "Niño 3.4", "south": -5, "north": 5, "west": -170, "east": -120,
     "about": "Main region NOAA uses to declare El Niño and La Niña."},
    {"id": "nino4", "name": "Niño 4", "south": -5, "north": 5, "west": -200, "east": -150,
     "about": "Central/western equatorial Pacific (160°E-150°W)."},
]
WEEKLY_COLUMNS = ["nino12", "nino3", "nino34", "nino4"]

_WEEK_LINE = re.compile(r"^\s*(\d{2}[A-Z]{3}\d{4})\s+(.*)$")
_NUMBER = re.compile(r"-?\d+\.\d+")
_ONI_LINE = re.compile(r"^\s*([A-Z]{3})\s+(\d{4})\s+(-?\d+\.\d+)\s+(-?\d+\.\d+)\s*$")


def parse_weekly(text: str) -> list[dict[str, Any]]:
    """Rows of {"week": ISO date, "<region>": {"sst", "anomaly"}}, oldest first."""
    rows = []
    for line in text.splitlines():
        m = _WEEK_LINE.match(line)
        if not m:
            continue
        numbers = [float(n) for n in _NUMBER.findall(m.group(2))]
        if len(numbers) != 8:
            continue
        week = dt.datetime.strptime(m.group(1).title(), "%d%b%Y").date()
        row: dict[str, Any] = {"week": week.isoformat()}
        for i, region in enumerate(WEEKLY_COLUMNS):
            row[region] = {"sst": numbers[2 * i], "anomaly": numbers[2 * i + 1]}
        rows.append(row)
    return rows


def parse_oni(text: str) -> list[dict[str, Any]]:
    return [
        {"season": m.group(1), "year": int(m.group(2)), "anomaly": float(m.group(4))}
        for m in map(_ONI_LINE.match, text.splitlines()) if m
    ]


def classify(anomaly: float) -> tuple[str, str]:
    """(phase, strength) from a Niño 3.4 anomaly using NOAA's thresholds."""
    size = abs(anomaly)
    strength = ("very strong" if size >= 2.0 else "strong" if size >= 1.5
                else "moderate" if size >= 1.0 else "weak" if size >= 0.5 else "")
    if anomaly >= 0.5:
        return "el_nino", strength
    if anomaly <= -0.5:
        return "la_nina", strength
    return "neutral", ""


def summarise(weekly: list[dict[str, Any]], oni: list[dict[str, Any]]) -> dict[str, Any]:
    if not weekly:
        raise services.UpstreamError("No weekly Niño data")
    latest = weekly[-1]
    month_ago = weekly[-5] if len(weekly) >= 5 else weekly[0]

    nino34 = latest["nino34"]["anomaly"]
    trend = round(nino34 - month_ago["nino34"]["anomaly"], 2)
    phase, strength = classify(nino34)

    regions = []
    for region in REGIONS:
        rid = region["id"]
        regions.append({
            **region,
            "sst": latest[rid]["sst"],
            "anomaly": latest[rid]["anomaly"],
            "change_4w": round(latest[rid]["anomaly"] - month_ago[rid]["anomaly"], 2),
            "history": [row[rid]["anomaly"] for row in weekly[-12:]],
        })
    focus = max(regions, key=lambda r: r["anomaly"])

    rising = trend >= 0.2
    falling = trend <= -0.2
    if phase == "el_nino":
        headline = f"{strength.capitalize()} El Niño conditions" + (", still strengthening" if rising else "")
    elif phase == "la_nina":
        headline = f"{strength.capitalize()} La Niña conditions" + (", fading" if rising else "")
    elif rising and nino34 > 0:
        headline = "Neutral, but the Pacific is warming toward El Niño"
    elif falling and nino34 < 0:
        headline = "Neutral, but the Pacific is cooling toward La Niña"
    else:
        headline = "ENSO-neutral"

    if focus["anomaly"] >= 0.5:
        focus_text = (f"Warming is strongest in {focus['name']} "
                      f"({focus['anomaly']:+.1f} °C above normal). {focus['about']}")
    else:
        focus_text = "No Niño region is more than 0.5 °C above normal right now."

    return {
        "week": latest["week"],
        "nino34_anomaly": nino34,
        "trend_4w": trend,
        "phase": phase,
        "strength": strength,
        "headline": headline,
        "focus": {"id": focus["id"], "text": focus_text},
        "regions": regions,
        "weeks": [row["week"] for row in weekly[-12:]],
        "oni": oni[-6:],
        "note": ("Based on the latest weekly Niño 3.4 anomaly. NOAA officially declares El Niño "
                 "using the 3-month ONI together with atmospheric signs."),
    }


def sst_anomaly_layer(today: dt.date | None = None) -> dict[str, Any]:
    day = (today or dt.datetime.now(dt.timezone.utc).date()) - dt.timedelta(days=SST_LATENCY_DAYS)
    catalogue = satellites._catalogue("gibs")
    name = satellites._pick(catalogue, SST_ANOMALY_PATTERNS) if catalogue else None
    info = catalogue[name] if name else SST_ANOMALY_FALLBACK
    name = name or SST_ANOMALY_FALLBACK["layer"]
    return {
        "layer": name,
        "date": day.isoformat(),
        "url": satellites.GIBS_TILE_URL.format(layer=name, time=day.isoformat(),
                                               matrix_set=info["matrix_set"], ext=info["ext"]),
        "max_native_zoom": satellites._max_zoom(info["matrix_set"]),
        "attribution": 'SST anomaly: GHRSST MUR via <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
    }


def get_enso() -> dict[str, Any]:
    def fetch() -> dict[str, Any]:
        weekly = parse_weekly(services._get_text(WEEKLY_URL))
        try:
            oni = parse_oni(services._get_text(ONI_URL))
        except services.UpstreamError:
            oni = []
        return summarise(weekly, oni)

    data = dict(services.cache.get_or_set("enso", 6 * 3600, fetch))
    data["sst_layer"] = sst_anomaly_layer()
    data["sources"] = [
        {"name": "NOAA CPC weekly Niño SST indices", "url": WEEKLY_URL},
        {"name": "NOAA CPC Oceanic Niño Index (ONI)", "url": ONI_URL},
        {"name": "NOAA CPC ENSO diagnostic discussion", "url": CPC_DISCUSSION_URL},
        {"name": "GHRSST MUR SST anomaly (NASA JPL) via NASA GIBS",
         "url": "https://podaac.jpl.nasa.gov/MEaSUREs-MUR"},
    ]
    return data
