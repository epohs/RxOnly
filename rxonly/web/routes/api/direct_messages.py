import json
from typing import Any, Optional

from flask import request, Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp
from rxonly.web.db import get_db_connection



@api_bp.route("/direct-messages", methods=["GET"])
def get_direct_messages() -> Response:

  if not Config.get("LOG_DIRECT_MESSAGES"):
    payload: dict[str, Any] = {
      "meta": {
        "limit": 0, "total": 0, "max_direct_messages": 0,
        "has_more_older": False, "has_more_newer": False,
      },
      "direct_messages": [],
    }
    return Response(json.dumps(payload, indent=2), mimetype="application/json")

  max_direct_messages: int = Config.get("MAX_DIRECT_MESSAGES", 1000)

  limit: int = request.args.get("limit", default=50, type=int)

  # Cursor-based pagination parameters
  after_rx_time: Optional[int] = request.args.get("after_rx_time", type=int)
  before_rx_time: Optional[int] = request.args.get("before_rx_time", type=int)
  newest: bool = request.args.get("newest", default="", type=str) == "1"

  if limit < 1:
    limit = 1
  if limit > max_direct_messages:
    limit = max_direct_messages

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    # Build WHERE clause parts
    where_parts: list[str] = []
    params: list[Any] = []

    if after_rx_time is not None and not newest:
      where_parts.append("dm.rx_time > ?")
      params.append(after_rx_time)
    elif before_rx_time is not None and not newest:
      where_parts.append("dm.rx_time < ?")
      params.append(before_rx_time)

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # Total count (unfiltered by cursor)
    cur.execute("SELECT COUNT(*) AS count FROM direct_messages")
    total: int = cur.fetchone()["count"]

    # Determine sort order
    if newest or before_rx_time is not None:
      order_clause = "ORDER BY dm.rx_time DESC, dm.id DESC"
    else:
      order_clause = "ORDER BY dm.rx_time ASC, dm.id ASC"

    query = f"""
      SELECT dm.id, dm.message_id, dm.from_node, dm.text, dm.rx_time,
             dm.snr, dm.rssi, dm.reply_to, dm.via_mqtt,
             n.long_name AS from_node_long_name,
             n.short_name AS from_node_short_name,
             parent.text AS reply_to_text,
             parent.from_node AS reply_to_from_node,
             pn.short_name AS reply_to_from_node_short_name
      FROM direct_messages dm
      LEFT JOIN nodes n ON dm.from_node = n.node_id
      LEFT JOIN direct_messages parent ON dm.reply_to = parent.message_id
      LEFT JOIN nodes pn ON parent.from_node = pn.node_id
      {where_clause}
      {order_clause}
      LIMIT ?
    """
    params.append(limit)

    cur.execute(query, params)
    rows: list[dict[str, Any]] = [dict(row) for row in cur.fetchall()]

    # Reverse DESC results so output is always oldest-first (ASC)
    if newest or before_rx_time is not None:
      rows.reverse()

    # Determine has_more_older / has_more_newer
    has_more_older = False
    has_more_newer = False

    if rows:
      oldest_rx_time = rows[0]["rx_time"]
      newest_rx_time = rows[-1]["rx_time"]
      oldest_id = rows[0]["id"]
      newest_id = rows[-1]["id"]

      # LIMIT 1 stops at first match
      cur.execute(
        "SELECT 1 FROM direct_messages dm WHERE (dm.rx_time < ? OR (dm.rx_time = ? AND dm.id < ?)) LIMIT 1",
        (oldest_rx_time, oldest_rx_time, oldest_id),
      )
      has_more_older = cur.fetchone() is not None

      cur.execute(
        "SELECT 1 FROM direct_messages dm WHERE (dm.rx_time > ? OR (dm.rx_time = ? AND dm.id > ?)) LIMIT 1",
        (newest_rx_time, newest_rx_time, newest_id),
      )
      has_more_newer = cur.fetchone() is not None

  finally:
    conn.close()

  payload: dict[str, Any] = {
    "meta": {
      "limit": limit,
      "total": total,
      "has_more_older": has_more_older,
      "has_more_newer": has_more_newer,
      "max_direct_messages": max_direct_messages,
    },
    "direct_messages": rows,
  }

  return Response(
    json.dumps(payload, indent=2),
    mimetype="application/json",
  )


@api_bp.route("/direct-messages/<int:message_id>", methods=["GET"])
def get_direct_message(message_id: int) -> Response:
  """Return a single direct message by message_id with enriched node names."""

  if not Config.get("LOG_DIRECT_MESSAGES"):
    return Response(
      json.dumps({"error": "Direct message not found"}),
      status=404,
      mimetype="application/json",
    )

  conn = get_db_connection()
  try:
    cur = conn.cursor()
    cur.execute(
      """
      SELECT dm.id, dm.message_id, dm.from_node, dm.text, dm.rx_time,
             dm.snr, dm.rssi, dm.reply_to, dm.via_mqtt,
             n.long_name AS from_node_long_name,
             n.short_name AS from_node_short_name,
             parent.text AS reply_to_text,
             parent.from_node AS reply_to_from_node,
             pn.short_name AS reply_to_from_node_short_name
      FROM direct_messages dm
      LEFT JOIN nodes n ON dm.from_node = n.node_id
      LEFT JOIN direct_messages parent ON dm.reply_to = parent.message_id
      LEFT JOIN nodes pn ON parent.from_node = pn.node_id
      WHERE dm.message_id = ?
      """,
      (message_id,),
    )
    row = cur.fetchone()
  finally:
    conn.close()

  if row is None:
    return Response(
      json.dumps({"error": "Direct message not found"}),
      status=404,
      mimetype="application/json",
    )

  return Response(
    json.dumps(dict(row), indent=2),
    mimetype="application/json",
  )
