import json

from typing import Any

from flask import Blueprint, Response, current_app

api_bp = Blueprint("api", __name__, url_prefix="/api")


def json_response(payload: Any, status: int = 200) -> Response:
  """One JSON body, compact in production and indented under DEBUG.

  Every route here used to build its own `Response(json.dumps(payload, indent=2))`,
  and the indentation was costing real work on the Pi for nobody's benefit.
  `/api/nodes?limit=50` went out as 28 KB where the same payload compact is 20 KB:
  eight kilobytes of newlines and leading spaces that the serializer had to produce
  and Flask-Compress then had to compress, every ten seconds, per open tab. Brotli
  hides it on the wire, which is exactly why it went unnoticed for so long — the
  cost was never the bytes, it was the CPU spent making bytes that were about to be
  squeezed back out again.

  It is kept under DEBUG rather than deleted, because reading a raw response by
  hand is what the indentation was always for, and a developer curling an endpoint
  is the one reader who benefits from it. `current_app.debug` rather than the
  project's own Config: `create_app` sets it from `Config.get("DEBUG")`, so the two
  never disagree, and this way the pretty-printing follows the app that is actually
  serving the request.

  `separators` is explicit because json.dumps' default is `", "` and `": "`, which
  leaves a space after every comma and colon — with indent set that is the right
  choice and is what makes an indented body readable, and without it those spaces
  are several hundred more bytes of nothing.
  """
  if current_app.debug:
    body = json.dumps(payload, indent=2)
  else:
    body = json.dumps(payload, separators=(",", ":"))

  return Response(body, status=status, mimetype="application/json")


from rxonly.web.routes.api import nodes
from rxonly.web.routes.api import messages
from rxonly.web.routes.api import channels
from rxonly.web.routes.api import direct_messages
from rxonly.web.routes.api import stats
