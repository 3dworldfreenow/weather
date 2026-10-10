"""Build the static GitHub Pages demo into ./dist.

The page is rendered by the Flask app with STATIC_SITE=True, so the browser
fetches forecasts, grids, search and radar directly from the free APIs (see
static/js/static-api.js). Data that browsers cannot fetch themselves (NOAA
files without CORS, satellite catalogues, events) is pre-built here into
dist/data/*.json. A scheduled GitHub Actions workflow re-runs this script.

Usage:  python scripts/build_static.py [output_dir]
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from weather_app import create_app, enso, satellites, services  # noqa: E402

log = logging.getLogger("build_static")


def satellites_data() -> dict:
    styles = {}
    for style in satellites.STYLES:
        data = satellites.get_satellites(style=style)
        time = data["time"]
        layers = []
        for layer in data["layers"]:
            # The browser fills in the newest image time itself.
            layer = {**layer, "url": layer["url"].replace(time, "{time}")}
            layer.pop("time", None)
            layers.append(layer)
        styles[style] = {"layers": layers}
    return {"styles": styles}


def build(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    (out / "data").mkdir(parents=True)

    app = create_app({"STATIC_SITE": True})
    html = app.test_client().get("/").get_data(as_text=True)
    # GitHub Pages serves the site from /<repo>/, so use relative asset paths.
    html = html.replace('"/static/', '"static/')
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / "404.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    shutil.copytree(ROOT / "weather_app" / "static", out / "static")

    builders = {
        "satellites.json": satellites_data,
        "enso.json": enso.get_enso,
        "events.json": lambda: {"events": services.get_events()},
    }
    failed = []
    for name, builder in builders.items():
        try:
            data = builder()
        except Exception as exc:  # keep the site up even if one source is down
            log.error("Could not build %s: %s", name, exc)
            failed.append(name)
            continue
        (out / "data" / name).write_text(json.dumps(data), encoding="utf-8")
    (out / "data" / "build.json").write_text(json.dumps({
        "built_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "failed": failed,
    }), encoding="utf-8")
    print(f"Built static site in {out}" + (f" (missing: {', '.join(failed)})" if failed else ""))
    if "satellites.json" in failed:
        sys.exit(1)  # the globe and live layers need this one


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist")
