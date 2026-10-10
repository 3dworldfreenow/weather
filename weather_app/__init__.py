"""Flask application factory for the El Niño Tracker."""

from __future__ import annotations

import os

from flask import Flask


def create_app(config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev"),
        JSON_SORT_KEYS=False,
        SITE_URL=os.environ.get("SITE_URL"),
        # Search Console / Bing Webmaster Tools ownership codes (optional).
        GOOGLE_SITE_VERIFICATION=os.environ.get("GOOGLE_SITE_VERIFICATION"),
        BING_SITE_VERIFICATION=os.environ.get("BING_SITE_VERIFICATION"),
    )
    if config:
        app.config.update(config)

    @app.template_filter("signed")
    def signed(value: float, digits: int = 1) -> str:
        return f"{'+' if value >= 0 else '−'}{abs(value):.{digits}f}"

    from .routes import bp
    app.register_blueprint(bp)
    return app
