import json
from typing import Any

from flask import Response

from rxonly.web.routes.api import api_bp
from rxonly.web.db import get_db_connection



@api_bp.route("/channels", methods=["GET"])
def get_channels() -> Response:

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    cur.execute(
      """
      SELECT channel_index, name
      FROM channels
      ORDER BY channel_index ASC
      """
    )

    rows: list[dict[str, Any]] = [dict(row) for row in cur.fetchall()]
  finally:
    conn.close()

  payload: dict[str, Any] = {
    "channels": rows,
  }

  return Response(
    json.dumps(payload, indent=2),
    mimetype="application/json",
  )
