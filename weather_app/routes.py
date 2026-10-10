"""HTML page and JSON API routes."""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, render_template, request

from . import satellites, services

bp = Blueprint("main", __name__)


def _float_arg(name: str, lo: float, hi: float) -> float:
    raw = request.args.get(name)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        raise ValueError(f"'{name}' must be a number") from None
    if not lo <= value <= hi:
        raise ValueError(f"'{name}' must be between {lo} and {hi}")
    return value


@bp.errorhandler(ValueError)
def bad_request(exc: ValueError):
    return jsonify(error=str(exc)), 400


@bp.errorhandler(services.UpstreamError)
def upstream_failed(exc: services.UpstreamError):
    current_app.logger.warning("Upstream error: %s", exc)
    if exc.rate_limited:
        message = ("The free weather data limit was reached. "
                   "Please wait a minute and try again.")
        return jsonify(error=message, reason=exc.reason), 503
    message = "Weather data provider is unavailable, please try again."
    if exc.reason:
        message = f"Weather data provider error: {exc.reason}"
    return jsonify(error=message), 502


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/api/weather")
def weather():
    lat = _float_arg("lat", -90, 90)
    lon = _float_arg("lon", -180, 180)
    return jsonify(services.get_forecast(lat, lon))


@bp.get("/api/search")
def search():
    return jsonify(results=services.search_places(request.args.get("q", "")))


@bp.get("/api/grid")
def grid():
    layer = request.args.get("layer", "")
    south = _float_arg("south", -90, 90)
    north = _float_arg("north", -90, 90)
    west = _float_arg("west", -540, 540)
    east = _float_arg("east", -540, 540)
    return jsonify(services.get_grid(layer, south, west, north, east))


@bp.get("/api/radar")
def radar():
    return jsonify(services.get_radar_frames())


@bp.get("/api/satellites")
def satellite_layers():
    return jsonify(satellites.get_satellites())


@bp.get("/api/events")
def events():
    return jsonify(events=services.get_events())


@bp.get("/healthz")
def health():
    return jsonify(status="ok")
