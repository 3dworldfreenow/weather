"""Live geostationary satellite imagery stitched into one global cloud layer.

Five geostationary weather satellites together see almost the whole planet.
Each one is shown only inside its own longitude band (seams halfway between
neighbouring satellites), the same idea zoom.earth uses:

    GOES-West (NOAA)       ~137.2 W   via NASA GIBS
    GOES-East (NOAA)        ~75.2 W   via NASA GIBS
    Meteosat 0 deg (EUMETSAT)   0     via EUMETView
    Meteosat IODC (EUMETSAT) ~45.5 E  via EUMETView
    Himawari (JMA)         ~140.7 E   via NASA GIBS

Infrared (~10.4 um) imagery is used because it shows clouds day and night.
Layer names are discovered from each provider's GetCapabilities document at
run time (and refreshed every few hours), so renamed or replaced products are
picked up without code changes; well-known names are used as a fallback.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import xml.etree.ElementTree as ET
from typing import Any

import requests

from .services import USER_AGENT, cache

log = logging.getLogger(__name__)

GIBS_CAPABILITIES = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
GIBS_TILE_URL = ("https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
                 "{layer}/default/{time}/{matrix_set}/{{z}}/{{y}}/{{x}}.{ext}")
EUMETVIEW_WMS = "https://view.eumetsat.int/geoserver/wms"
EUMETVIEW_CAPABILITIES = "https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetCapabilities&version=1.3.0"

CAPABILITIES_TTL = 6 * 3600
CAPABILITIES_TIMEOUT = 30
FAILURE_RETRY = 300
# Geostationary images reach the archives with some delay.
IMAGE_LATENCY = dt.timedelta(minutes=40)
IMAGE_STEP_MINUTES = 10


def _seam(a: float, b: float) -> float:
    return (a + b) / 2


# Sub-satellite longitudes, west -> east.
_LON = {"goes_west": -137.2, "goes_east": -75.2, "meteosat": 0.0, "iodc": 45.5, "himawari": 140.7}

SATELLITES: list[dict[str, Any]] = [
    {
        "id": "goes_west", "name": "GOES-West", "agency": "NOAA", "source": "gibs",
        "patterns": [r"^GOES-West_ABI_Band13_Clean_Infrared$", r"^GOES-West_ABI_Band13"],
        "fallback": {"layer": "GOES-West_ABI_Band13_Clean_Infrared",
                     "matrix_set": "GoogleMapsCompatible_Level6", "ext": "png"},
        "band": [_seam(_LON["himawari"], _LON["goes_west"] + 360) - 360,
                 _seam(_LON["goes_west"], _LON["goes_east"])],
    },
    {
        "id": "goes_east", "name": "GOES-East", "agency": "NOAA", "source": "gibs",
        "patterns": [r"^GOES-East_ABI_Band13_Clean_Infrared$", r"^GOES-East_ABI_Band13"],
        "fallback": {"layer": "GOES-East_ABI_Band13_Clean_Infrared",
                     "matrix_set": "GoogleMapsCompatible_Level6", "ext": "png"},
        "band": [_seam(_LON["goes_west"], _LON["goes_east"]),
                 _seam(_LON["goes_east"], _LON["meteosat"])],
    },
    {
        "id": "meteosat", "name": "Meteosat 0°", "agency": "EUMETSAT", "source": "eumetview",
        "patterns": [r"^mtg_fd:ir105_hrfi$", r"^mtg_fd:ir105", r"^msg_fes:ir108$"],
        "fallback": {"layer": "msg_fes:ir108"},
        "band": [_seam(_LON["goes_east"], _LON["meteosat"]),
                 _seam(_LON["meteosat"], _LON["iodc"])],
    },
    {
        "id": "iodc", "name": "Meteosat IODC", "agency": "EUMETSAT", "source": "eumetview",
        "patterns": [r"^msg_iodc:ir108$", r"^msg_iodc:ir"],
        "fallback": {"layer": "msg_iodc:ir108"},
        "band": [_seam(_LON["meteosat"], _LON["iodc"]),
                 _seam(_LON["iodc"], _LON["himawari"])],
    },
    {
        "id": "himawari", "name": "Himawari", "agency": "JMA", "source": "gibs",
        "patterns": [r"^Himawari_AHI_Band13_Clean_Infrared$", r"^Himawari_AHI_Band13"],
        "fallback": {"layer": "Himawari_AHI_Band13_Clean_Infrared",
                     "matrix_set": "GoogleMapsCompatible_Level6", "ext": "png"},
        "band": [_seam(_LON["iodc"], _LON["himawari"]),
                 _seam(_LON["himawari"], _LON["goes_west"] + 360)],
    },
]

ATTRIBUTION = {
    "gibs": 'Satellite <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>',
    "eumetview": 'Satellite &copy; <a href="https://view.eumetsat.int/">EUMETSAT</a>',
}

_WMTS = "{http://www.opengis.net/wmts/1.0}"
_OWS = "{http://www.opengis.net/ows/1.1}"
_WMS = "{http://www.opengis.net/wms}"


def _download(url: str) -> bytes:
    resp = requests.get(url, timeout=CAPABILITIES_TIMEOUT, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp.content


def parse_gibs_layers(xml: bytes) -> dict[str, dict[str, str]]:
    """Return {identifier: {matrix_set, ext}} for every WMTS layer."""
    layers = {}
    root = ET.fromstring(xml)
    for layer in root.iter(f"{_WMTS}Layer"):
        ident = layer.findtext(f"{_OWS}Identifier")
        if not ident:
            continue
        fmt = layer.findtext(f"{_WMTS}Format") or "image/png"
        matrix_sets = [el.text for el in layer.iter(f"{_WMTS}TileMatrixSet") if el.text]
        if not matrix_sets:
            continue
        layers[ident] = {
            "matrix_set": matrix_sets[0],
            "ext": "jpg" if "jpeg" in fmt else "png",
        }
    return layers


def parse_wms_layer_names(xml: bytes) -> list[str]:
    root = ET.fromstring(xml)
    names = [el.text for el in root.iter(f"{_WMS}Name") if el.text]
    if not names:  # WMS 1.1.1 has no namespace
        names = [el.text for el in root.iter("Name") if el.text]
    return names


def _pick(names, patterns: list[str]) -> str | None:
    for pattern in patterns:
        rx = re.compile(pattern, re.IGNORECASE)
        matches = sorted(n for n in names if rx.search(n))
        if matches:
            return matches[0]
    return None


_MISSING = object()


def _catalogue(source: str) -> Any:
    """Cached, parsed capabilities for one provider (None if unavailable)."""
    key = ("satellite-capabilities", source)
    cached = cache.get(key, _MISSING)
    if cached is not _MISSING:
        return cached
    try:
        if source == "gibs":
            result = parse_gibs_layers(_download(GIBS_CAPABILITIES))
        else:
            result = parse_wms_layer_names(_download(EUMETVIEW_CAPABILITIES))
        cache.set(key, result, CAPABILITIES_TTL)
    except (requests.RequestException, ET.ParseError) as exc:
        log.warning("Could not load %s capabilities: %s", source, exc)
        result = None
        cache.set(key, None, FAILURE_RETRY)  # use fallback names, retry later
    return result


def latest_image_time(now: dt.datetime | None = None) -> str:
    """Most recent 10-minute slot that is very likely already published."""
    now = (now or dt.datetime.now(dt.timezone.utc)) - IMAGE_LATENCY
    now = now.replace(minute=now.minute - now.minute % IMAGE_STEP_MINUTES, second=0, microsecond=0)
    return now.strftime("%Y-%m-%dT%H:%M:%SZ")


def _max_zoom(matrix_set: str) -> int:
    m = re.search(r"Level(\d+)", matrix_set)
    return int(m.group(1)) if m else 6


def get_satellites(now: dt.datetime | None = None) -> dict[str, Any]:
    image_time = latest_image_time(now)
    layers = []
    for sat in SATELLITES:
        catalogue = _catalogue(sat["source"])
        discovered = catalogue is not None
        entry: dict[str, Any] = {
            "id": sat["id"],
            "name": sat["name"],
            "agency": sat["agency"],
            "band": [round(v, 2) for v in sat["band"]],
            "attribution": ATTRIBUTION[sat["source"]],
        }
        if sat["source"] == "gibs":
            name = _pick(catalogue or {}, sat["patterns"]) if discovered else None
            if discovered and not name:
                continue  # Provider no longer offers this satellite.
            info = catalogue[name] if name else sat["fallback"]
            name = name or sat["fallback"]["layer"]
            entry.update({
                "type": "wmts",
                "layer": name,
                "url": GIBS_TILE_URL.format(layer=name, time=image_time,
                                            matrix_set=info["matrix_set"], ext=info["ext"]),
                "max_native_zoom": _max_zoom(info["matrix_set"]),
            })
        else:
            name = _pick(catalogue or [], sat["patterns"]) if discovered else None
            if discovered and not name:
                continue
            entry.update({
                "type": "wms",
                "layer": name or sat["fallback"]["layer"],
                "url": EUMETVIEW_WMS,
                "max_native_zoom": 8,
            })
        entry["verified"] = discovered
        layers.append(entry)
    return {"time": image_time, "layers": layers}
