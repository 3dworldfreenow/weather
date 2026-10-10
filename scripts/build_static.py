"""Build the static GitHub Pages demo into ./dist.

The page is rendered by the Flask app with STATIC_SITE=True. The data the
browser needs (NOAA El Niño files, which have no CORS headers, and the
satellite catalogues) is pre-built here into dist/data/*.json, which
static/js/static-api.js reads. A scheduled GitHub Actions workflow re-runs
this script to keep it fresh.

Usage:  python scripts/build_static.py [output_dir]
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from weather_app import create_app, enso, news, satellites, seo  # noqa: E402

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


def default_site_url() -> str:
    """Public URL of the demo: SITE_URL, else derived from the GitHub repository."""
    if os.environ.get("SITE_URL"):
        return os.environ["SITE_URL"]
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in repo:
        owner, name = repo.lower().split("/", 1)
        if name == f"{owner}.github.io":  # a user/organisation site lives at the root
            return f"https://{name}/"
        return f"https://{owner}.github.io/{name}/"
    return "http://localhost:8000/"


def build(out: Path, site_url: str | None = None) -> None:
    site_url = seo.site_url(site_url or default_site_url(), "/")
    if out.exists():
        shutil.rmtree(out)
    (out / "data").mkdir(parents=True)

    # 1. Data files (each one optional except the satellites).
    builders = {
        "satellites.json": satellites_data,
        "enso.json": enso.get_enso,
        "news.json": news.get_news,
    }
    built, failed = {}, []
    for name, builder in builders.items():
        try:
            built[name] = builder()
        except Exception as exc:  # keep the site up even if one source is down
            log.error("Could not build %s: %s", name, exc)
            failed.append(name)
            continue
        (out / "data" / name).write_text(json.dumps(built[name]), encoding="utf-8")
    now = dt.datetime.now(dt.timezone.utc)
    (out / "data" / "build.json").write_text(json.dumps({
        "built_at": now.isoformat(timespec="seconds"),
        "failed": failed,
    }), encoding="utf-8")

    # 2. The page, pre-filled with the El Niño status and headlines for search engines.
    app = create_app({
        "STATIC_SITE": True,
        "SITE_URL": site_url,
        "PAGE_DATA": {
            "enso": built.get("enso.json"),
            "headlines": (built.get("news.json") or {}).get("articles", [])[:12],
        },
    })
    html = app.test_client().get("/").get_data(as_text=True)
    # GitHub Pages serves the site from /<repo>/, so use relative asset paths.
    html = html.replace('"/static/', '"static/')
    (out / "index.html").write_text(html, encoding="utf-8")
    # Same app for unknown URLs, but keep those out of search results.
    (out / "404.html").write_text(
        html.replace('<meta name="robots" content="index, follow, max-image-preview:large">',
                     '<meta name="robots" content="noindex">'), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    shutil.copytree(ROOT / "weather_app" / "static", out / "static")

    # 3. Search engine and app files.
    (out / "robots.txt").write_text(seo.robots(site_url), encoding="utf-8")
    (out / "sitemap.xml").write_text(seo.sitemap(site_url, now.date()), encoding="utf-8")
    (out / "manifest.webmanifest").write_text(json.dumps(seo.manifest(), ensure_ascii=False), encoding="utf-8")

    print(f"Built static site for {site_url} in {out}" + (f" (missing: {', '.join(failed)})" if failed else ""))
    if "satellites.json" in failed:
        sys.exit(1)  # the globe and live layers need this one


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist")
