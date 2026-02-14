import json
from typing import Any, Optional

from flask import request, Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp
from rxonly.web.db import get_db_connection



@api_bp.route("/messages", methods=["GET"])
def get_messages() -> Response:

  max_messages: int = Config.get("MAX_MESSAGES", 1000)

  limit: int = request.args.get("limit", default=50, type=int)
  channel_index: Optional[int] = request.args.get("channel_index", type=int)

  # Cursor-based pagination parameters
  after_rx_time: Optional[int] = request.args.get("after_rx_time", type=int)
  before_rx_time: Optional[int] = request.args.get("before_rx_time", type=int)
  newest: bool = request.args.get("newest", default="", type=str) == "1"

  if limit < 1:
    limit = 1
  if limit > max_messages:
    limit = max_messages

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    # Build WHERE clause parts
    where_parts: list[str] = []
    params: list[Any] = []

    if channel_index is not None:
      where_parts.append("m.channel_index = ?")
      params.append(channel_index)

    if after_rx_time is not None and not newest:
      where_parts.append("m.rx_time > ?")
      params.append(after_rx_time)
    elif before_rx_time is not None and not newest:
      where_parts.append("m.rx_time < ?")
      params.append(before_rx_time)

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # Total count for this channel (unfiltered by cursor)
    if channel_index is not None:
      cur.execute(
        "SELECT COUNT(*) AS count FROM messages WHERE channel_index = ?",
        (channel_index,),
      )
    else:
      cur.execute("SELECT COUNT(*) AS count FROM messages")
    total: int = cur.fetchone()["count"]

    # Determine sort order
    if newest or before_rx_time is not None:
      # Fetch in DESC to get the most recent N, then reverse for ASC output
      order_clause = "ORDER BY m.rx_time DESC, m.id DESC"
    else:
      order_clause = "ORDER BY m.rx_time ASC, m.id ASC"

    query = f"""
      SELECT m.id, m.message_id, m.channel_index, m.from_node, m.to_node,
             m.reply_to, m.text, m.rx_time, m.hop_count, m.snr, m.rssi,
             m.via_mqtt, n.long_name AS from_node_long_name, n.short_name
             AS from_node_short_name,
             parent.text AS reply_to_text,
             parent.from_node AS reply_to_from_node,
             pn.short_name AS reply_to_from_node_short_name
      FROM messages m
      LEFT JOIN nodes n ON m.from_node = n.node_id
      LEFT JOIN messages parent ON m.reply_to = parent.message_id
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

      # Check for older messages (LIMIT 1 stops at first match)
      older_where = ["(m.rx_time < ? OR (m.rx_time = ? AND m.id < ?))"]
      older_params: list[Any] = [oldest_rx_time, oldest_rx_time, oldest_id]
      if channel_index is not None:
        older_where.append("m.channel_index = ?")
        older_params.append(channel_index)

      cur.execute(
        f"SELECT 1 FROM messages m WHERE {' AND '.join(older_where)} LIMIT 1",
        older_params,
      )
      has_more_older = cur.fetchone() is not None

      # Check for newer messages (LIMIT 1 stops at first match)
      newer_where = ["(m.rx_time > ? OR (m.rx_time = ? AND m.id > ?))"]
      newer_params: list[Any] = [newest_rx_time, newest_rx_time, newest_id]
      if channel_index is not None:
        newer_where.append("m.channel_index = ?")
        newer_params.append(channel_index)

      cur.execute(
        f"SELECT 1 FROM messages m WHERE {' AND '.join(newer_where)} LIMIT 1",
        newer_params,
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
      "channel_index": channel_index,
      "max_messages": max_messages,
    },
    "messages": rows,
  }

  return Response(
    json.dumps(payload, indent=2),
    mimetype="application/json",
  )


@api_bp.route("/messages/<int:message_id>", methods=["GET"])
def get_message(message_id: int) -> Response:
  """Return a single message by message_id with enriched node and channel names."""

  conn = get_db_connection()
  try:
    cur = conn.cursor()
    cur.execute(
      """
      SELECT m.id, m.message_id, m.channel_index, m.from_node, m.to_node,
             m.reply_to, m.text, m.rx_time, m.hop_count, m.snr, m.rssi, m.via_mqtt,
             n.long_name AS from_node_long_name,
             n.short_name AS from_node_short_name,
             c.name AS channel_name,
             parent.text AS reply_to_text,
             parent.from_node AS reply_to_from_node,
             pn.short_name AS reply_to_from_node_short_name
      FROM messages m
      LEFT JOIN nodes n ON m.from_node = n.node_id
      LEFT JOIN channels c ON m.channel_index = c.channel_index
      LEFT JOIN messages parent ON m.reply_to = parent.message_id
      LEFT JOIN nodes pn ON parent.from_node = pn.node_id
      WHERE m.message_id = ?
      """,
      (message_id,),
    )
    row = cur.fetchone()
  finally:
    conn.close()

  if row is None:
    return Response(
      json.dumps({"error": "Message not found"}),
      status=404,
      mimetype="application/json",
    )

  return Response(
    json.dumps(dict(row), indent=2),
    mimetype="application/json",
  )
