"""HTML page and JSON API routes."""

from __future__ import annotations

import json

from flask import Blueprint, Response, abort, current_app, jsonify, render_template, request

from . import crops, enso, impacts, news, satellites, seo, services

bp = Blueprint("main", __name__)


@bp.errorhandler(ValueError)
def bad_request(exc: ValueError):
    return jsonify(error=str(exc)), 400


@bp.errorhandler(services.UpstreamError)
def upstream_failed(exc: services.UpstreamError):
    current_app.logger.warning("Upstream error: %s", exc)
    if exc.rate_limited:
        return jsonify(error="The data provider's free limit was reached. Please try again shortly."), 503
    message = "Data provider is unavailable, please try again."
    if exc.reason:
        message = f"Data provider error: {exc.reason}"
    return jsonify(error=message), 502


def base_url() -> str:
    return seo.site_url(current_app.config.get("SITE_URL"), request.url_root)


def page_data() -> tuple[dict | None, list[dict]]:
    """El Niño summary and news articles to pre-render into pages for search engines.

    The static build passes fresh data in PAGE_DATA; the server uses whatever is
    already cached (never blocks the page on a slow upstream).
    """
    data = current_app.config.get("PAGE_DATA")
    if data is not None:
        return data.get("enso"), data.get("articles") or []
    cached_news = services.cache.get("news") or {}
    return services.cache.get("enso"), cached_news.get("articles") or []


def verification() -> dict:
    return {
        "google_verification": current_app.config.get("GOOGLE_SITE_VERIFICATION"),
        "bing_verification": current_app.config.get("BING_SITE_VERIFICATION"),
    }


@bp.get("/")
def index():
    url = base_url()
    enso_data, articles = page_data()
    return render_template(
        "index.html",
        app_config={"static": bool(current_app.config.get("STATIC_SITE"))},
        meta={**seo.page_meta(url), **verification()},
        json_ld=seo.json_ld(url, enso_data),
        faq=seo.FAQ,
        impacts=impacts.public_data(),
        enso=enso_data,
        headlines=[a for a in articles if a.get("elnino", True)][:12],
    )


@bp.get("/impacts/<slug>/")
def impact_page(slug: str):
    c = impacts.BY_SLUG.get(slug)
    if c is None:
        abort(404)
    url = base_url()
    enso_data, articles = page_data()
    related = [r for r in impacts.COUNTRIES if r["region"] == c["region"] and r["slug"] != slug]
    return render_template(
        "impact.html",
        c=c,
        effect=impacts.EFFECTS[c["effect"]],
        crop_regions=[
            {**r, "crop_name": crops.CROPS[r["crop"]]["name"], "icon": crops.CROPS[r["crop"]]["icon"]}
            for r in crops.REGIONS if r["country"] == slug
        ],
        meta={**seo.impact_meta(url, c), **verification()},
        json_ld=seo.impact_json_ld(url, c),
        enso=enso_data,
        news=[a for a in articles if slug in (a.get("countries") or []) and a.get("elnino", True)][:10],
        related=related,
        sources=impacts.SOURCES,
    )


@bp.get("/crops/")
def crops_page():
    url = base_url()
    enso_data, articles = page_data()
    crop_news = [a for a in articles if a.get("crops")][:15]
    return render_template(
        "crops.html",
        app_config={"static": bool(current_app.config.get("STATIC_SITE"))},
        meta={**seo.crops_meta(url), **verification()},
        json_ld=seo.crops_json_ld(url),
        info=crops.public_info(),
        countries=impacts.BY_SLUG,
        enso=enso_data,
        headlines=crop_news,
    )


@bp.get("/news/")
def news_page():
    url = base_url()
    enso_data, articles = page_data()
    return render_template(
        "news.html",
        app_config={"static": bool(current_app.config.get("STATIC_SITE"))},
        meta={**seo.news_meta(url), **verification()},
        json_ld=seo.news_json_ld(url, articles),
        themes=[{k: v for k, v in t.items() if k != "keywords"} for t in impacts.THEMES],
        countries={c["slug"]: {"name": c["name"]} for c in impacts.COUNTRIES},
        crop_names={cid: {"name": c["name"], "icon": c["icon"]} for cid, c in crops.CROPS.items()},
        enso=enso_data,
        headlines=articles[:40],
    )


@bp.get("/api/crops")
def crops_data():
    """Crop info and world prices. Rainfall comes per region from /api/crops/rain."""
    def prices():
        out = {}
        for crop_id in crops.CROPS:
            try:
                out[crop_id] = crops.fetch_price(crop_id)
            except services.UpstreamError as exc:
                current_app.logger.warning("Crop price %s: %s", crop_id, exc)
        return out

    def fx():
        try:
            return crops.fetch_fx()
        except services.UpstreamError as exc:
            current_app.logger.warning("Exchange rates: %s", exc)
            return None

    return jsonify({"prices": services.cache.get_or_set("crop-prices", 12 * 3600, prices), "rain": {},
                    "fx": services.cache.get_or_set("crop-fx", 6 * 3600, fx)})


@bp.get("/api/crops/rain")
def crop_rain():
    region = crops.REGION_BY_ID.get(request.args.get("region", ""))
    if region is None:
        raise ValueError("Unknown region")
    return jsonify(services.cache.get_or_set(("crop-rain", region["id"]), 12 * 3600, lambda: crops.fetch_rain(region)))


@bp.get("/robots.txt")
def robots_txt():
    return Response(seo.robots(base_url()), mimetype="text/plain")


@bp.get("/sitemap.xml")
def sitemap_xml():
    paths = ["news/", "crops/"] + [seo.impact_path(c["slug"]) for c in impacts.COUNTRIES]
    return Response(seo.sitemap(base_url(), paths=paths), mimetype="application/xml")


@bp.get("/manifest.webmanifest")
def manifest():
    return Response(json.dumps(seo.manifest()), mimetype="application/manifest+json")


@bp.get("/api/satellites")
def satellite_layers():
    return jsonify(satellites.get_satellites(style=request.args.get("style", "infrared")))


@bp.get("/api/enso")
def enso_status():
    return jsonify(enso.get_enso())


@bp.get("/api/news")
def news_feed():
    return jsonify(news.get_news())


@bp.get("/healthz")
def health():
    return jsonify(status="ok")
