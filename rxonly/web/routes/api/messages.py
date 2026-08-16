from typing import Any, Optional

from flask import request, Response

from rxonly.web.routes.api import api_bp, json_response
from rxonly.web.db import cursor_clause, get_db_connection, get_meta_int


# Page size to clamp to when the collector hasn't published max_messages. Matches
# the default page size, so paging still works without over-reading an archive
# whose size we can't confirm.
FALLBACK_MAX_MESSAGES = 50



@api_bp.route("/messages", methods=["GET"])
def get_messages() -> Response:

  limit: int = request.args.get("limit", default=50, type=int)
  channel_index: Optional[int] = request.args.get("channel_index", type=int)

  # Cursor-based pagination parameters. A cursor is an `(rx_time, id)` pair; the id
  # is optional and the timestamp alone still pages, for the reasons and with the
  # one caveat set out on `cursor_clause`.
  after_rx_time: Optional[int] = request.args.get("after_rx_time", type=int)
  after_id: Optional[int] = request.args.get("after_id", type=int)
  before_rx_time: Optional[int] = request.args.get("before_rx_time", type=int)
  before_id: Optional[int] = request.args.get("before_id", type=int)
  newest: bool = request.args.get("newest", default="", type=str) == "1"

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    # The collector owns the retention limit; clamp to what it publishes rather
    # than to this process's own idea of it.
    max_messages: int = get_meta_int(conn, "max_messages", FALLBACK_MAX_MESSAGES)

    if limit < 1:
      limit = 1
    if limit > max_messages:
      limit = max_messages

    # What this page is *of*, held apart from where in it the page starts. The
    # total, the cursor's tie probe and both has_more probes are all under the same
    # restriction the page is, and a channel filter that reached only some of them is
    # how the pager came to disagree with its own has_more in the first place.
    scope_parts: list[str] = []
    scope_params: list[Any] = []

    if channel_index is not None:
      scope_parts.append("m.channel_index = ?")
      scope_params.append(channel_index)

    scope = " AND ".join(scope_parts)

    # Build WHERE clause parts
    where_parts: list[str] = list(scope_parts)
    params: list[Any] = list(scope_params)

    if after_rx_time is not None and not newest:
      condition, cursor_params = cursor_clause(
        cur, "messages", "m",
        direction="after", rx_time=after_rx_time, row_id=after_id,
        scope=scope, scope_params=tuple(scope_params),
      )
      where_parts.append(condition)
      params.extend(cursor_params)
    elif before_rx_time is not None and not newest:
      condition, cursor_params = cursor_clause(
        cur, "messages", "m",
        direction="before", rx_time=before_rx_time, row_id=before_id,
        scope=scope, scope_params=tuple(scope_params),
      )
      where_parts.append(condition)
      params.extend(cursor_params)

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # Total count for this channel (unfiltered by cursor). One expression rather
    # than a branch per scope, so a new scope cannot arrive with a total ignoring it.
    scope_where = (" WHERE " + scope) if scope else ""
    cur.execute(f"SELECT COUNT(*) AS count FROM messages m{scope_where}", scope_params)
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
             m.via_mqtt, m.emoji,
             n.long_name AS from_node_long_name, n.short_name
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
      # Built by the same helper the page above used, against the ends of the page
      # just served. Scoped like it too — a "more older" pointing at another
      # channel's rows would make the client page towards messages it never draws.
      scope_filter = f" AND {scope}" if scope else ""

      # Check for older messages (LIMIT 1 stops at first match)
      older_condition, older_params = cursor_clause(
        cur, "messages", "m",
        direction="before", rx_time=rows[0]["rx_time"], row_id=rows[0]["id"],
        scope=scope, scope_params=tuple(scope_params),
      )
      cur.execute(
        f"SELECT 1 FROM messages m WHERE {older_condition}{scope_filter} LIMIT 1",
        [*older_params, *scope_params],
      )
      has_more_older = cur.fetchone() is not None

      # Check for newer messages (LIMIT 1 stops at first match)
      newer_condition, newer_params = cursor_clause(
        cur, "messages", "m",
        direction="after", rx_time=rows[-1]["rx_time"], row_id=rows[-1]["id"],
        scope=scope, scope_params=tuple(scope_params),
      )
      cur.execute(
        f"SELECT 1 FROM messages m WHERE {newer_condition}{scope_filter} LIMIT 1",
        [*newer_params, *scope_params],
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
      # The cursors to hand back for the next page in either direction, so no caller
      # has to reassemble a pair out of the rows and risk dropping the id — which is
      # exactly what the client used to do. Named as mesh-console names them.
      "oldest": [rows[0]["rx_time"], rows[0]["id"]] if rows else None,
      "newest": [rows[-1]["rx_time"], rows[-1]["id"]] if rows else None,
    },
    "messages": rows,
  }

  return json_response(payload)


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
             m.emoji,
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
    return json_response({"error": "Message not found"}, status=404)

  return json_response(dict(row))
