"""HTML page and JSON API routes."""

from __future__ import annotations

import json

from flask import Blueprint, Response, current_app, jsonify, render_template, request

from . import enso, news, satellites, seo, services

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
    """El Niño summary and headlines to pre-render into the page for search engines.

    The static build passes fresh data in PAGE_DATA; the server uses whatever is
    already cached (never blocks the page on a slow upstream).
    """
    data = current_app.config.get("PAGE_DATA")
    if data is not None:
        return data.get("enso"), data.get("headlines") or []
    cached_news = services.cache.get("news") or {}
    return services.cache.get("enso"), (cached_news.get("articles") or [])[:12]


@bp.get("/")
def index():
    url = base_url()
    enso_data, headlines = page_data()
    return render_template(
        "index.html",
        app_config={"static": bool(current_app.config.get("STATIC_SITE"))},
        meta={
            **seo.page_meta(url),
            "google_verification": current_app.config.get("GOOGLE_SITE_VERIFICATION"),
            "bing_verification": current_app.config.get("BING_SITE_VERIFICATION"),
        },
        json_ld=seo.json_ld(url, enso_data),
        faq=seo.FAQ,
        enso=enso_data,
        headlines=headlines,
    )


@bp.get("/robots.txt")
def robots_txt():
    return Response(seo.robots(base_url()), mimetype="text/plain")


@bp.get("/sitemap.xml")
def sitemap_xml():
    return Response(seo.sitemap(base_url()), mimetype="application/xml")


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
