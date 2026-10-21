"""Radar rain prediction ("nowcast") made on the server and published as map tiles.

Every build (every 10 minutes) this reads RainViewer's newest radar images for all areas
of the world with rain, measures how the rain moved over the past hour with optical
flow (OpenCV DIS, the method used by radar nowcasting tools such as rainymotion), moves
the newest image further along that motion and writes predicted radar images for the
next hour as 256-px PNG tiles (zoom 5) plus nowcast.json describing them. The browser
only shows these images, so phones do no heavy work.

Limits: like every extrapolation nowcast it assumes rain keeps its motion and strength;
storms forming or dying out are not predicted. A guide for the next hour.
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import io
import json
import logging
import math
import time
from pathlib import Path
from typing import Any

import requests

from . import services

log = logging.getLogger(__name__)

MAPS_URL = "https://api.rainviewer.com/public/weather-maps.json"
ZOOM = 5                 # tiles written (1 px ≈ 4.9 km at the equator)
FIND_ZOOM = 3            # overview used to find where it rains
STEP_MIN = 10            # minutes between predicted images
FRAMES = 6               # 1 hour ahead
BASE_STEPS = 3           # motion measured over 30 minutes, twice (the past hour)
THRESHOLD = 0.05         # intensity counted as rain
WORKERS = 8              # parallel downloads (RainViewer limits busy clients)

# Rain colours, intensity = (dBZ − 5) / 50 (also sent to the browser in nowcast.json).
RAMP = [[0.05, [30, 60, 200, 0.5]], [0.25, [40, 100, 255, 0.85]], [0.4, [90, 80, 245, 0.95]],
        [0.5, [150, 60, 220, 1]], [0.6, [215, 45, 150, 1]], [0.7, [245, 40, 50, 1]], [0.8, [255, 140, 20, 1]],
        [0.9, [255, 220, 0, 1]], [1, [255, 255, 190, 1]]]

# RainViewer "Universal Blue" colours (the scheme its free API serves): dBZ, r, g, b.
UNIVERSAL_BLUE = [
    (5, 146, 136, 113), (6, 158, 147, 117), (7, 170, 158, 121), (8, 182, 169, 126), (9, 194, 180, 130), (10, 206, 192, 135),
    (11, 210, 196, 139), (12, 214, 200, 143), (13, 218, 204, 147), (14, 222, 208, 151), (15, 136, 221, 238), (16, 108, 209, 235),
    (17, 81, 197, 232), (18, 54, 186, 229), (19, 27, 174, 226), (20, 0, 163, 224), (21, 0, 154, 213), (22, 0, 145, 202),
    (23, 0, 136, 191), (24, 0, 127, 180), (25, 0, 119, 170), (26, 0, 112, 163), (27, 0, 105, 156), (28, 0, 98, 149),
    (29, 0, 91, 142), (30, 0, 85, 136), (31, 0, 81, 128), (32, 0, 78, 120), (33, 0, 74, 112), (34, 0, 71, 104),
    (35, 255, 238, 0), (36, 255, 224, 0), (37, 255, 210, 0), (38, 255, 197, 0), (39, 255, 183, 0), (40, 255, 170, 0),
    (41, 255, 159, 0), (42, 255, 149, 0), (43, 255, 139, 0), (44, 255, 129, 0), (45, 255, 68, 0), (46, 242, 54, 0),
    (47, 230, 40, 0), (48, 217, 27, 0), (49, 205, 13, 0), (50, 193, 0, 0), (51, 168, 0, 0), (52, 143, 0, 0),
    (53, 118, 0, 0), (54, 93, 0, 0), (55, 255, 170, 255), (56, 255, 159, 255), (57, 255, 149, 255), (58, 255, 139, 255),
    (59, 255, 129, 255), (60, 255, 119, 255), (61, 255, 108, 255), (62, 255, 98, 255), (63, 255, 88, 255), (64, 255, 78, 255),
    (65, 255, 255, 255), (66, 255, 255, 255), (67, 255, 255, 255), (68, 255, 255, 255), (69, 255, 255, 255), (70, 255, 255, 255),
    (71, 255, 255, 255), (72, 255, 255, 255), (73, 255, 255, 255), (74, 255, 255, 255),
]


# ---------------------------------------------------------------------------
# Reading RainViewer tiles
# ---------------------------------------------------------------------------
def _np():
    import numpy as np  # imported lazily: only the build needs numpy/OpenCV
    return np


_lut_cache: dict[int, int] = {}


def decode(rgba) -> Any:
    """RGBA tile (H×W×4 uint8) → rain intensity 0..255 (uint8)."""
    np = _np()
    out = np.zeros(rgba.shape[:2], np.uint8)
    mask = rgba[..., 3] >= 96
    if not mask.any():
        return out
    px = rgba[mask][:, :3].astype(np.int32)
    keys = (px[:, 0] << 16) | (px[:, 1] << 8) | px[:, 2]
    uniq, inv = np.unique(keys, return_inverse=True)
    table = np.array(UNIVERSAL_BLUE, np.int32)
    vals = np.empty(len(uniq), np.uint8)
    for i, k in enumerate(uniq.tolist()):
        v = _lut_cache.get(k)
        if v is None:
            rgb = np.array([(k >> 16) & 255, (k >> 8) & 255, k & 255])
            dbz = table[np.argmin(((table[:, 1:] - rgb) ** 2).sum(1)), 0]
            v = int(round(max(0.0, min(1.0, (dbz - 5) / 50)) * 255))
            _lut_cache[k] = v
        vals[i] = v
    out[mask] = vals[inv]
    return out


STATS: dict[str, int] = {}


def _fetch_tile(session: requests.Session, url: str):
    """A decoded radar tile, or None. Waits and retries when rate-limited."""
    np = _np()
    from PIL import Image
    for attempt in range(5):
        try:
            resp = session.get(url, timeout=30)
        except requests.RequestException as exc:
            STATS[type(exc).__name__] = STATS.get(type(exc).__name__, 0) + 1
            time.sleep(1 + attempt)
            continue
        STATS[str(resp.status_code)] = STATS.get(str(resp.status_code), 0) + 1
        if resp.status_code == 200:
            try:
                return decode(np.asarray(Image.open(io.BytesIO(resp.content)).convert("RGBA")))
            except OSError:
                return None
        if resp.status_code in (429, 500, 502, 503, 504):
            wait = resp.headers.get("Retry-After", "")
            time.sleep(min(30, float(wait)) if wait.replace(".", "", 1).isdigit() else 2 * (attempt + 1))
            continue
        return None
    return None


def tile_url(host: str, path: str, z: int, x: int, y: int) -> str:
    return f"{host}{path}/256/{z}/{x}/{y}/2/0_0.png"


def rainy_tiles(session, host: str, path: str) -> set[tuple[int, int]]:
    """Zoom-5 tiles with rain in or next to them (rain can move in from a neighbour)."""
    n3, f = 2 ** FIND_ZOOM, 2 ** (ZOOM - FIND_ZOOM)
    jobs = {(x, y): tile_url(host, path, FIND_ZOOM, x, y) for x in range(n3) for y in range(n3)}
    found: set[tuple[int, int]] = set()
    with cf.ThreadPoolExecutor(WORKERS) as pool:
        for (x, y), g in zip(jobs, pool.map(lambda u: _fetch_tile(session, u), jobs.values())):
            if g is None or not (g > THRESHOLD * 255).any():
                continue
            # Which zoom-5 children have rain (each covers 256/f px of this tile).
            s = 256 // f
            for j in range(f):
                for i in range(f):
                    if (g[j * s:(j + 1) * s, i * s:(i + 1) * s] > THRESHOLD * 255).any():
                        found.add((x * f + i, y * f + j))
    n = 2 ** ZOOM
    ring = {((x + dx) % n, y + dy) for x, y in found for dx in (-1, 0, 1) for dy in (-1, 0, 1) if 0 <= y + dy < n}
    return ring


def mosaic(session, host: str, path: str, tiles: set[tuple[int, int]]):
    """The world at zoom 5 (8192×8192 intensity, uint8) with only `tiles` filled in."""
    np = _np()
    n = 2 ** ZOOM
    world = np.zeros((n * 256, n * 256), np.uint8)
    keys = sorted(tiles)
    with cf.ThreadPoolExecutor(WORKERS) as pool:
        for (x, y), g in zip(keys, pool.map(lambda t: _fetch_tile(session, tile_url(host, path, ZOOM, *t)), keys)):
            if g is not None:
                world[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = g
    return world


# ---------------------------------------------------------------------------
# Motion and prediction
# ---------------------------------------------------------------------------
def motion(first, mid, now):
    """Backward motion per BASE_STEPS (half resolution, px of the half-size image):
    the pixel at x in `now` came from x + flow. Average of the last two half hours."""
    import cv2
    np = _np()
    half = lambda g: cv2.resize(g, (g.shape[1] // 2, g.shape[0] // 2), interpolation=cv2.INTER_AREA)
    a, b, c = half(first), half(mid), half(now)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    f1 = dis.calc(c, b, None)  # now → 30 min ago
    f2 = dis.calc(b, a, None)  # 30 → 60 min ago
    flow = (f1 + f2) / 2
    # Smooth so neighbouring rain moves together (removes noisy vectors).
    flow = cv2.GaussianBlur(flow, (0, 0), 12)
    return flow.astype(np.float32)


def colorize(g) -> Any:
    """Intensity tile (uint8) → RGBA with the rain colours and soft edges."""
    np = _np()
    v = g.astype(np.float32) / 255
    out = np.zeros(g.shape + (4,), np.uint8)
    stops = np.array([s[0] for s in RAMP], np.float32)
    cols = np.array([s[1][:3] + [s[1][3] * 255] for s in RAMP], np.float32)
    k = np.clip(np.searchsorted(stops, v), 1, len(stops) - 1)
    t = np.clip((v - stops[k - 1]) / (stops[k] - stops[k - 1]), 0, 1)[..., None]
    rgba = cols[k - 1] * (1 - t) + cols[k] * t
    edge = np.clip((v - 0.03) / 0.07, 0, 1)
    rgba[..., 3] *= edge
    out[...] = np.clip(rgba, 0, 255).astype(np.uint8)
    return out


def predict_tile(world, flow, x: int, y: int, minutes: int):
    """Predicted intensity of one zoom-5 tile `minutes` ahead (semi-Lagrangian, backward)."""
    import cv2
    np = _np()
    pad = 8
    size = 256 + 2 * pad
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    gx = xx + x * 256 - pad
    gy = yy + y * 256 - pad
    # Flow at these pixels (half resolution field, bilinear), scaled to full pixels.
    fx = cv2.remap(flow[..., 0], gx / 2, gy / 2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) * 2
    fy = cv2.remap(flow[..., 1], gx / 2, gy / 2, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE) * 2
    k = minutes / (STEP_MIN * BASE_STEPS)
    W = world.shape[1]
    src_x = (gx + fx * k) % W  # the world wraps east–west
    src_y = gy + fy * k
    out = cv2.remap(world, src_x, src_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    out = cv2.GaussianBlur(out, (0, 0), 1.2)  # soft, smooth rain areas
    return out[pad:-pad, pad:-pad]


def overviews(level: dict[tuple[int, int], Any]) -> dict[tuple[int, int, int], Any]:
    """Tiles for zooms ZOOM−1 … 0 (each from its four children, halved), so the
    prediction also shows on the zoomed-out globe."""
    import cv2
    np = _np()
    out: dict[tuple[int, int, int], Any] = {}
    for z in range(ZOOM - 1, -1, -1):
        parents: dict[tuple[int, int], Any] = {}
        for (x, y), img in level.items():
            big = parents.setdefault((x // 2, y // 2), np.zeros((512, 512, 4), np.uint8))
            big[(y % 2) * 256:(y % 2 + 1) * 256, (x % 2) * 256:(x % 2 + 1) * 256] = img
        level = {key: cv2.resize(big, (256, 256), interpolation=cv2.INTER_AREA) for key, big in parents.items()}
        out.update({(z, x, y): img for (x, y), img in level.items()})
    return out


def tile_motion(flow, x: int, y: int, world) -> list[float] | None:
    """Mean motion of the rain in a tile: [km/h, direction it moves towards (degrees)]."""
    np = _np()
    sl = (slice(y * 128, (y + 1) * 128), slice(x * 128, (x + 1) * 128))
    rain = world[y * 256:(y + 1) * 256:2, x * 256:(x + 1) * 256:2] > THRESHOLD * 255
    if rain.sum() < 20:
        return None
    fx, fy = flow[sl][..., 0][rain].mean(), flow[sl][..., 1][rain].mean()
    # Backward flow: rain moves by −flow every 30 min, in half-size pixels.
    n = 2 ** ZOOM * 256
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) * 256 / n))))
    km_px = 40075.016686 * math.cos(math.radians(lat)) / n * 2
    kmh = math.hypot(fx, fy) * km_px * (60 / (STEP_MIN * BASE_STEPS))
    towards = (math.degrees(math.atan2(-fx, fy)) + 360) % 360  # east of north; y grows southwards
    return [round(kmh, 1), round(towards)]


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build(out: Path, url_base: str = "nowcast", now: dt.datetime | None = None) -> dict[str, Any]:
    """Write predicted tiles under out/<url_base>/<radar time>/<k>/<x>/<y>.png and return
    the description (also the content of nowcast.json)."""
    from PIL import Image
    np = _np()
    now = now or dt.datetime.now(dt.timezone.utc)
    session = requests.Session()
    session.headers["User-Agent"] = services.USER_AGENT
    session.mount("https://", requests.adapters.HTTPAdapter(pool_connections=WORKERS, pool_maxsize=WORKERS))
    maps = session.get(MAPS_URL, timeout=30).json()
    host, past = maps["host"], maps["radar"]["past"]
    if len(past) < 2 * BASE_STEPS + 1:
        raise services.UpstreamError("Not enough radar images")
    latest, mid, first = past[-1], past[-1 - BASE_STEPS], past[-1 - 2 * BASE_STEPS]
    STATS.clear()
    tiles = rainy_tiles(session, host, latest["path"])
    log.info("Nowcast: %d tiles with rain", len(tiles))
    log.info("Nowcast overview downloads: %s", STATS)
    STATS.clear()
    worlds = [mosaic(session, host, f["path"], tiles) for f in (first, mid, latest)]
    log.info("Nowcast downloads: %s", STATS)
    if not tiles or not (worlds[2] > THRESHOLD * 255).any():
        raise services.UpstreamError(f"No radar data downloaded ({STATS})")
    flow = motion(*worlds)
    world = worlds[2]
    del worlds

    run = str(latest["time"])
    root = out / url_base / run
    frames = []
    for k in range(1, FRAMES + 1):
        tiles_k: dict[tuple[int, int, int], Any] = {}
        for x, y in sorted(tiles):
            g = predict_tile(world, flow, x, y, k * STEP_MIN)
            if (g > THRESHOLD * 255).any():
                tiles_k[(ZOOM, x, y)] = colorize(g)
        tiles_k.update(overviews({key[1:]: img for key, img in tiles_k.items()}))
        for (z, x, y), img in tiles_k.items():
            d = root / str(k) / str(z) / str(x)
            d.mkdir(parents=True, exist_ok=True)
            Image.fromarray(img, "RGBA").save(d / f"{y}.png", optimize=True)
        frames.append({"time": latest["time"] + k * STEP_MIN * 60, "path": f"{url_base}/{run}/{k}",
                       "tiles": sorted(f"{z}/{x}/{y}" for z, x, y in tiles_k)})
    motions = {f"{x}/{y}": m for x, y in sorted(tiles) if (m := tile_motion(flow, x, y, world))}
    return {
        "built_at": now.isoformat(timespec="seconds"),
        "radar_time": latest["time"],
        "zoom": ZOOM,
        "step_min": STEP_MIN,
        "frames": frames,
        "motion": motions,
        "ramp": RAMP,
        "attribution": "Prediction: El Niño Tracker from RainViewer radar",
    }


def write(out: Path) -> dict[str, Any]:
    """Build into a static site directory: tiles plus data/nowcast.json."""
    info = build(out)
    (out / "data").mkdir(parents=True, exist_ok=True)
    (out / "data" / "nowcast.json").write_text(json.dumps(info, separators=(",", ":")), encoding="utf-8")
    return info
