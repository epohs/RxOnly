from typing import Any, Optional

from flask import request, Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp, json_response
from rxonly.web.db import (
  cursor_clause, get_db_connection, get_meta, get_meta_int, drawn_rows
)


# See FALLBACK_MAX_MESSAGES in messages.py.
FALLBACK_MAX_DIRECT_MESSAGES = 50


# How a row is narrowed to one conversation: the peer is on it somewhere.
#
# mesh-console derives the peer with a CASE against the local node id
# (_PEER_OF_ROW in its db/queries.py); this is the same fact asked the other way
# round, and it holds for the same reason that CASE is total — every row in
# direct_messages involves the local node, so a row that involves the peer at all
# is a row of the conversation with them. Asking it this way needs no local node
# id in the filter, which matters here because the message page is also how a
# shared thread URL resolves, and it should not go blank on an archive that has
# not yet named its device.
_CONVERSATION_WITH = "(dm.from_node = ? OR dm.to_node = ?)"



@api_bp.route("/direct-messages", methods=["GET"])
def get_direct_messages() -> Response:

  # Whether to expose direct messages is this process's decision, and defaults
  # to no regardless of what the archive holds.
  if not Config.get("SERVE_DIRECT_MESSAGES"):
    payload: dict[str, Any] = {
      "meta": {
        "limit": 0, "total": 0, "max_direct_messages": 0,
        "has_more_older": False, "has_more_newer": False,
        "oldest": None, "newest": None,
      },
      "direct_messages": [],
    }
    return json_response(payload)

  limit: int = request.args.get("limit", default=50, type=int)

  # One conversation rather than all of them. The threaded index passes this to
  # page a single thread; absent, the page is every direct message at once, which
  # is what a DM detail's context and any old bookmark still get.
  peer: Optional[str] = request.args.get("peer", type=str)

  # Cursor-based pagination parameters. Pairs, as in messages.py and for the same
  # reason — see `cursor_clause`. Kept as its own copy rather than shared with the
  # channel pager, which is how the two endpoints have always been arranged.
  after_rx_time: Optional[int] = request.args.get("after_rx_time", type=int)
  after_id: Optional[int] = request.args.get("after_id", type=int)
  before_rx_time: Optional[int] = request.args.get("before_rx_time", type=int)
  before_id: Optional[int] = request.args.get("before_id", type=int)
  newest: bool = request.args.get("newest", default="", type=str) == "1"

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    max_direct_messages: int = get_meta_int(
      conn, "max_direct_messages", FALLBACK_MAX_DIRECT_MESSAGES
    )

    if limit < 1:
      limit = 1
    if limit > max_direct_messages:
      limit = max_direct_messages

    # Which conversation this page is of, held apart from where in it the page
    # starts, so the total, the cursor's tie probe and both has_more probes are all
    # under the restriction the page itself is under.
    scope_parts: list[str] = []
    scope_params: list[Any] = []

    if peer:
      scope_parts.append(_CONVERSATION_WITH)
      scope_params.extend([peer, peer])

    scope = " AND ".join(scope_parts)

    # Build WHERE clause parts
    where_parts: list[str] = list(scope_parts)
    params: list[Any] = list(scope_params)

    if after_rx_time is not None and not newest:
      condition, cursor_params = cursor_clause(
        cur, "direct_messages", "dm",
        direction="after", rx_time=after_rx_time, row_id=after_id,
        scope=scope, scope_params=tuple(scope_params),
      )
      where_parts.append(condition)
      params.extend(cursor_params)
    elif before_rx_time is not None and not newest:
      condition, cursor_params = cursor_clause(
        cur, "direct_messages", "dm",
        direction="before", rx_time=before_rx_time, row_id=before_id,
        scope=scope, scope_params=tuple(scope_params),
      )
      where_parts.append(condition)
      params.extend(cursor_params)

    where_clause = (" WHERE " + " AND ".join(where_parts)) if where_parts else ""

    # Total count (unfiltered by cursor, scoped to the conversation when there is
    # one — the total describes what the caller is paging through)
    scope_where = (" WHERE " + scope) if scope else ""
    cur.execute(
      f"SELECT COUNT(*) AS count FROM direct_messages dm{scope_where}", scope_params
    )
    total: int = cur.fetchone()["count"]

    # Determine sort order
    if newest or before_rx_time is not None:
      order_clause = "ORDER BY dm.rx_time DESC, dm.id DESC"
    else:
      order_clause = "ORDER BY dm.rx_time ASC, dm.id ASC"

    query = f"""
      SELECT dm.id, dm.message_id, dm.from_node, dm.text, dm.rx_time,
             dm.snr, dm.rssi, dm.reply_to, dm.via_mqtt, dm.emoji,
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
      # Scoped to the conversation when there is one, like the total above — a
      # "more older" that points at another thread's rows would make the client
      # page forever towards messages this view will never draw. Same shape as
      # the channel_index scoping in messages.py, and the same helper builds the
      # condition here as built the page's, so the two cannot mean different things.
      scope_filter = f" AND {scope}" if scope else ""

      older_condition, older_params = cursor_clause(
        cur, "direct_messages", "dm",
        direction="before", rx_time=rows[0]["rx_time"], row_id=rows[0]["id"],
        scope=scope, scope_params=tuple(scope_params),
      )
      # LIMIT 1 stops at first match
      cur.execute(
        f"SELECT 1 FROM direct_messages dm "
        f"WHERE {older_condition}{scope_filter} LIMIT 1",
        [*older_params, *scope_params],
      )
      has_more_older = cur.fetchone() is not None

      newer_condition, newer_params = cursor_clause(
        cur, "direct_messages", "dm",
        direction="after", rx_time=rows[-1]["rx_time"], row_id=rows[-1]["id"],
        scope=scope, scope_params=tuple(scope_params),
      )
      cur.execute(
        f"SELECT 1 FROM direct_messages dm "
        f"WHERE {newer_condition}{scope_filter} LIMIT 1",
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
      "max_direct_messages": max_direct_messages,
      # The next page's cursor in either direction, as messages.py reports it.
      "oldest": [rows[0]["rx_time"], rows[0]["id"]] if rows else None,
      "newest": [rows[-1]["rx_time"], rows[-1]["id"]] if rows else None,
    },
    "direct_messages": rows,
  }

  return json_response(payload)


@api_bp.route("/direct-messages/conversations", methods=["GET"])
def get_dm_conversations() -> Response:
  """Who this device has direct messages with, newest conversation first.

  The index the threaded DM view draws: one row per peer, carrying what the row
  needs to say — how big the thread is, when it last moved, and the newest thing
  in it that was not this device talking. mesh-console's fetch_conversations is
  the model (group by the end of the row that is not us, order by the newest
  thing in each group); the differences from it are deliberate and both point
  the same way:

  **Counts and times are over drawn rows.** mesh-console counts every archived
  row because its list draws every archived row. This list folds tapbacks into
  pills, so a row's count has to describe the thread it opens — the same rule
  every number in /api/stats already follows, for the reason documented on
  `drawn_rows`.

  **`newest_inbound_rx_time` is per row, because read state never leaves the
  browser.** mesh-console counts unread server-side from cursors it owns; this
  server has no idea what any given browser has read, so it reports the newest
  inbound drawn rx_time per conversation and the client compares it against the
  read position it stored. That yields a yes/no per thread, not a count — which
  is all the web interface has ever said about unread.

  **Nothing at all when the archive has named no device**, and the guard is not
  belt-and-braces: the peer of a row is derived against the local node id, and in
  SQL `from_node = NULL` is NULL rather than false, so without one every message
  would be filed as a conversation with its own sender — including the ones this
  device sent. mesh-console's rebuild_conversations refuses in the same place.

  `local_node` rides along so the client can draw the left-hand side of a row's
  title (`RX1 › ECHO`) without a second request racing the first paint.
  """

  if not Config.get("SERVE_DIRECT_MESSAGES"):
    return json_response({
      "meta": {"total": 0},
      "local_node": None,
      "conversations": [],
    })

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    local_node_id: Optional[str] = get_meta(conn, "local_node_id")

    local_node: Optional[dict[str, Any]] = None
    conversations: list[dict[str, Any]] = []

    if local_node_id:
      cur.execute(
        "SELECT node_id, short_name, long_name FROM nodes WHERE node_id = ?",
        (local_node_id,),
      )
      node_row = cur.fetchone()
      local_node = dict(node_row) if node_row else {"node_id": local_node_id}

      # The peer's names come along on a LEFT JOIN so a row can be rendered
      # without a request per conversation — LEFT because a node that has never
      # sent a NodeInfo is still somebody you have a conversation with, and the
      # client falls back to the hex id.
      #
      # The inbound CASE has no ELSE on purpose: a thread in which we have only
      # ever spoken reports NULL, which the client reads as nothing waiting. A
      # row with no from_node fails `!= ?` into the same NULL, which is right —
      # a message with no sender is not one waiting to be read from anybody.
      cur.execute(
        f"""
        SELECT d.peer,
               COUNT(*) AS message_count,
               MAX(d.rx_time) AS newest_rx_time,
               MAX(CASE WHEN d.from_node != ? THEN d.rx_time END)
                 AS newest_inbound_rx_time,
               pn.short_name AS peer_short_name,
               pn.long_name AS peer_long_name
        FROM (
          SELECT CASE WHEN dm.from_node = ? THEN dm.to_node ELSE dm.from_node END
                   AS peer,
                 dm.from_node, dm.rx_time
          FROM direct_messages dm
          WHERE {drawn_rows("direct_messages", "dm")}
        ) d
        LEFT JOIN nodes pn ON pn.node_id = d.peer
        WHERE d.peer IS NOT NULL
        GROUP BY d.peer, pn.short_name, pn.long_name
        ORDER BY newest_rx_time DESC, d.peer
        """,
        (local_node_id, local_node_id),
      )
      conversations = [dict(row) for row in cur.fetchall()]

  finally:
    conn.close()

  return json_response({
    "meta": {"total": len(conversations)},
    "local_node": local_node,
    "conversations": conversations,
  })


@api_bp.route("/direct-messages/<int:message_id>", methods=["GET"])
def get_direct_message(message_id: int) -> Response:
  """Return a single direct message by message_id with enriched node names."""

  if not Config.get("SERVE_DIRECT_MESSAGES"):
    return json_response({"error": "Direct message not found"}, status=404)

  conn = get_db_connection()
  try:
    cur = conn.cursor()
    cur.execute(
      """
      SELECT dm.id, dm.message_id, dm.from_node, dm.text, dm.rx_time,
             dm.snr, dm.rssi, dm.reply_to, dm.via_mqtt, dm.emoji,
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
    return json_response({"error": "Direct message not found"}, status=404)

  return json_response(dict(row))
