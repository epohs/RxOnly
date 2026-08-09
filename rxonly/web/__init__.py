from flask import Flask, Response
from flask_compress import Compress

from rxonly.config import Config
from rxonly.web.db import check_schema_version
from rxonly.web.routes import api_bp, dashboard_bp


def create_app() -> Flask:
  Config.load()

  # Fail on a schema this code can't read, at startup, rather than partway
  # through a request. mesh-collector owns the schema and can be upgraded
  # independently of this project.
  check_schema_version()

  app = Flask(__name__)
  app.config["DEBUG"] = Config.get("DEBUG", False)
  
  app.register_blueprint(api_bp)
  app.register_blueprint(dashboard_bp)

  @app.after_request
  def set_security_headers(response: Response) -> Response:
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response
  
  # Only enable compression in production mode
  if not app.config["DEBUG"]:
    # Compress CSS and JS using Flask-Compress
    Compress(app)

  return app
