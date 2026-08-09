import json
from typing import Any, Optional

from flask import request, Response

from rxonly.web.routes.api import api_bp
from rxonly.web.db import get_db_connection


# The six telemetry columns after altitude arrived in schema 0.8.0, and selecting
# them here is why REQUIRED_SCHEMA in web/db.py is 0.8.0 rather than 0.6.0. They
# are latest-value, not a series: each is the most recent reading of its kind and
# NULL for a node that has never sent that telemetry arm. NULL travels as JSON
# null and the frontend hides the row — see field_maps in static/js/rxonly.js —
# so a caller reading this API gets the same distinction the archive draws
# between "reported zero" and "never reported".


@api_bp.route("/nodes", methods=["GET"])
def get_nodes() -> Response:

  limit: int = request.args.get("limit", default=50, type=int)
  offset: int = request.args.get("offset", default=0, type=int)
  search: Optional[str] = request.args.get("search", default=None, type=str)

  if limit < 0:
    limit = 0
  if limit > 1000:
    limit = 1000
  if offset < 0:
    offset = 0

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    if search:
      search_pattern: str = f"%{search}%"

      cur.execute(
        """
        SELECT COUNT(*) AS count FROM nodes
        WHERE node_id LIKE ? OR short_name LIKE ? OR long_name LIKE ?
        """,
        (search_pattern, search_pattern, search_pattern),
      )
      total: int = cur.fetchone()["count"]

      cur.execute(
        """
        SELECT node_id, short_name, long_name, hardware, role,
               first_seen, last_seen, battery_level, voltage,
               snr, rssi, latitude, longitude, altitude,
               temperature, humidity, pressure,
               channel_util, air_util_tx, uptime_seconds
        FROM nodes
        WHERE node_id LIKE ? OR short_name LIKE ? OR long_name LIKE ?
        ORDER BY last_seen DESC
        LIMIT ? OFFSET ?
        """,
        (search_pattern, search_pattern, search_pattern, limit, offset),
      )

    else:
      cur.execute("SELECT COUNT(*) AS count FROM nodes")
      total = cur.fetchone()["count"]

      cur.execute(
        """
        SELECT node_id, short_name, long_name, hardware, role,
               first_seen, last_seen, battery_level, voltage,
               snr, rssi, latitude, longitude, altitude,
               temperature, humidity, pressure,
               channel_util, air_util_tx, uptime_seconds
        FROM nodes
        ORDER BY last_seen DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
      )

    rows: list[dict[str, Any]] = [dict(row) for row in cur.fetchall()]
  finally:
    conn.close()

  payload: dict[str, Any] = {
    "meta": {
      "limit": limit,
      "offset": offset,
      "total": total,
      "search": search,
    },
    "nodes": rows,
  }

  return Response(
    json.dumps(payload, indent=2),
    mimetype="application/json",
  )


@api_bp.route("/nodes/<node_id>", methods=["GET"])
def get_node(node_id: str) -> Response:

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    cur.execute(
      """
      SELECT node_id, short_name, long_name, hardware, role,
             first_seen, last_seen, battery_level, voltage,
             snr, rssi, latitude, longitude, altitude,
             temperature, humidity, pressure,
             channel_util, air_util_tx, uptime_seconds
      FROM nodes
      WHERE node_id = ?
      """,
      (node_id,),
    )

    row: Optional[dict[str, Any]] = cur.fetchone()
  finally:
    conn.close()

  if row is None:
    return Response(
      json.dumps({"error": "Node not found"}),
      status=404,
      mimetype="application/json",
    )

  return Response(
    json.dumps(dict(row), indent=2),
    mimetype="application/json",
  )
