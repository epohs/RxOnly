from flask import Flask, Response, request
from flask_compress import Compress

from rxonly.config import Config
from rxonly.web.assets import is_hashed_asset
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
# images, and makes no cross-origin requests. The single exception is opt-in, off
# by default, and named in one place — see `content_security_policy` below and
# ALLOW_CLOUDFLARE_BEACON in rxonly/config.py.
#
# **`style-src` is `'self'` alone.** It carried `'unsafe-inline'` as inherited from
# the proxy config this policy was moved out of, kept through that move so that
# moving it moved nothing else, and dropped here as its own change for the reason
# given then: the failure mode of being wrong is a live site with no styling at
# all, so it wanted a look at the real page rather than a grep.
#
# Nothing needs it. There is no inline `style` attribute and no `<style>` block in
# any template, and the JavaScript changes appearance exclusively through
# `classList` — 29 uses across the four modules, and not one `.style`, `cssText`,
# `setProperty` or `setAttribute("style", …)`, in the sources or in the built
# bundle that is what actually ships. Those are what a `style-src` without
# `'unsafe-inline'` blocks, and this app does none of them.
#
# **The one thing that does carry inline styles is `img/favicon.svg`**, whose every
# path element has a `style=` attribute. It is not an exception to the above: it is
# fetched as an image through `<link rel="icon">`, not parsed into this document,
# so its styles are never inline styles *of this page* whatever the policy says.
#
# Checked on the deployed site rather than reasoned about, because that file is the
# one thing here that could have made this change visible. The `after_request` hook
# puts the policy on every response including that one, so the SVG is served under
# `style-src 'self'` — and fetched that way it still renders with its fills intact,
# as a top-level document, which is a stricter question than the icon it is
# actually used as. The page itself renders fully styled and the console reports no
# violation of any directive. (Safari resolves the icon to the sized PNGs beside it
# and never asks for the SVG at all, so on this browser the question is moot twice
# over.) Worth knowing before someone inlines that SVG into a template one day:
# that is the change that would put those attributes in this document, and it is
# the one that would need the concession back.
#
# The one origin this policy will name that is not us, and only when asked to. See
# ALLOW_CLOUDFLARE_BEACON in rxonly/config.py for what turning it on concedes and
# why off is the default; the constant is here because this is the file that has
# to spell it, and a hostname buried in an f-string is a hostname nobody audits.
CLOUDFLARE_BEACON_ORIGIN = "https://static.cloudflareinsights.com"


def content_security_policy() -> str:
  """The policy for this process, which depends on one setting and nothing else.

  A function rather than the constant this was, because `script-src` now has two
  possible values and Config is not loaded at import time. Built once in
  `create_app` and closed over — the answer cannot change while the process runs,
  so a per-request rebuild would be work done 200 times a minute to get the same
  string back.

  One line, no newlines in the value: a literal newline in a header value is
  rejected over HTTP/2.
  """
  script_src = "'self'"
  if Config.get("ALLOW_CLOUDFLARE_BEACON", False):
    # script-src only. The beacon reports to `/cdn-cgi/rum` on this origin —
    # Cloudflare's edge answers that path for a proxied site — so `default-src
    # 'self'` already permits the reporting half and no `connect-src` is owed.
    # Verified against the live site rather than assumed, because the widening
    # nobody checks is the one that turns out to be unnecessary.
    script_src = f"'self' {CLOUDFLARE_BEACON_ORIGIN}"

  return (
    "default-src 'self'; "
    "img-src 'self'; "
    f"script-src {script_src}; "
    "style-src 'self'; "
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

# A year, which is the longest any cache is asked to honour and the conventional
# value for a file that will never change under its own name.
IMMUTABLE_MAX_AGE = 31_536_000

# For everything else under /static — the images, the manifest, and the unminified
# sources a DEBUG build serves. An hour is short enough that replacing an image is
# visible the same session and long enough to stop a browser asking about it on
# every page. These keep their ETag, so what happens after the hour is a 304 rather
# than a re-download.
STATIC_MAX_AGE = 3_600


def create_app() -> Flask:
  Config.load()

  # Fail on a schema this code can't read, at startup, rather than partway
  # through a request. mesh-collector owns the schema and can be upgraded
  # independently of this project.
  check_schema_version()

  app = Flask(__name__)
  app.config["DEBUG"] = Config.get("DEBUG", False)

  # Resolved once, after Config.load() above and before the first request. The
  # policy is a property of how this process was configured, not of the request.
  csp = content_security_policy()

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
    response.headers["Content-Security-Policy"] = csp
    response.headers["Permissions-Policy"] = PERMISSIONS_POLICY
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

  @app.after_request
  def set_cache_headers(response: Response) -> Response:
    """Let a browser keep a built asset instead of asking about it every time.

    **The build script hashes these filenames and then nothing took advantage of
    it.** Flask's static view sends `Cache-Control: no-cache` unless told otherwise,
    so every page load asked about every asset and was answered `304 Not Modified` —
    correct, cheap in bytes, and a round trip per file for a question whose answer
    was decided when the filename was chosen. `rxonly-1B161113.min.js` cannot change
    without becoming a different URL, which is the whole point of content hashing
    and is exactly what `immutable` means.

    Only the hashed names get that promise. `rxonly.css` and the images are served
    under a name that says nothing about their contents, so caching one for a year
    would mean a replaced image staying replaced-but-invisible until somebody
    cleared their browser. They get an hour and keep their ETag.

    **Nothing is cached under DEBUG**, where the templates serve the unminified
    sources and an edit is expected to show up on reload.

    The dashboard itself is untouched: it is not under `/static`, it is rendered per
    request, and the sidebar counts in it go stale in ten seconds.

    `/favicon.ico` is named alongside the static prefix rather than given a `max_age`
    of its own at the route, so that how long a client may keep a file this app
    serves is answered in one place. It is the one static thing that does not live
    under `/static/`, and it is 372 KB.
    """
    if app.debug or request.method not in ("GET", "HEAD"):
      return response

    is_static = request.path.startswith("/static/") or request.path == "/favicon.ico"
    if response.status_code != 200 or not is_static:
      return response

    if is_hashed_asset(request.path):
      response.headers["Cache-Control"] = (
        f"public, max-age={IMMUTABLE_MAX_AGE}, immutable"
      )
    else:
      response.headers["Cache-Control"] = f"public, max-age={STATIC_MAX_AGE}"

    return response

  # Only enable compression in production mode
  if not app.config["DEBUG"]:
    # Compress CSS and JS using Flask-Compress
    Compress(app)

  return app
