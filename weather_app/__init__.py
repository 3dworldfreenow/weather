"""Flask application factory for the weather map website."""

from __future__ import annotations

import os

from flask import Flask


def create_app(config: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("SECRET_KEY", "dev"),
        JSON_SORT_KEYS=False,
    )
    if config:
        app.config.update(config)

    from .routes import bp
    app.register_blueprint(bp)
    return app
