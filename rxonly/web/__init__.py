from flask import Flask, Response
from flask_compress import Compress

from rxonly.config import Config
from rxonly.web.db import check_schema_version
from rxonly.web.routes import api_bp, dashboard_bp


# What this app is allowed to load, and it is allowed to load almost nothing.
#
# **Set here rather than at the reverse proxy, which is where it used to live and
# only there.** deploy/nginx.conf.example carried this and the permissions policy
# while Flask carried the three weaker headers below — so a deployment that did
# not use that exact vhost, or reached this app through a tunnel, kept nosniff and
# lost the one header that actually contains an XSS. Which headers a response
# carries is a property of the application, not of whoever happens to be in front
# of it, and this is the layer that cannot be deployed around.
#
# Every directive here is one this app already satisfies: it serves its own CSS
# and JS from its own static directory, loads no fonts, no CDN and no remote
# images, and makes no cross-origin requests.
#
# **`'unsafe-inline'` on style-src is a concession nothing currently uses**, and it
# is byte-for-byte the policy this project already shipped at the proxy, kept
# unchanged so that moving it here moved it and nothing else. Dropping it would be
# strictly tighter and looks safe: there is not one inline `style` attribute or
# `<style>` block in the templates, and no JavaScript here touches `.style`,
# `cssText` or `setProperty`, which are what a `style-src` without it blocks. It
# stays for now because that is a change to the policy rather than to where the
# policy lives, and the two are worth landing separately — the failure mode of
# being wrong is a live site with no styling at all.
#
# One line, no newlines in the value: a literal newline in a header value is
# rejected over HTTP/2.
CONTENT_SECURITY_POLICY = (
  "default-src 'self'; "
  "img-src 'self'; "
  "script-src 'self'; "
  "style-src 'self' 'unsafe-inline'; "
  "object-src 'none'; "
  "base-uri 'self'; "
  "frame-ancestors 'none'"
)

# Nothing here needs a sensor, a camera or a location, so nothing here gets one.
# Same reasoning as the policy above, and it moved for the same reason.
PERMISSIONS_POLICY = (
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), "
  "magnetometer=(), microphone=(), payment=(), usb=()"
)


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
    """Every response, whatever is or is not in front of this app.

    Strict-Transport-Security is deliberately absent and stays the reverse
    proxy's: it is a claim about the transport, and this app cannot know whether
    it was reached over TLS. Sending it from here would either be a lie on a
    plain-HTTP development server or a duplicate of the proxy's. See
    deploy/nginx.conf.example, which is now the only place it is set.
    """
    response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
    response.headers["Permissions-Policy"] = PERMISSIONS_POLICY
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

  # Only enable compression in production mode
  if not app.config["DEBUG"]:
    # Compress CSS and JS using Flask-Compress
    Compress(app)

  return app
