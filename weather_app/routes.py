"""HTML page and JSON API routes."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, render_template, request

from . import enso, news, satellites, services

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


@bp.get("/")
def index():
    return render_template("index.html", app_config={
        "static": bool(current_app.config.get("STATIC_SITE")),
    })


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
