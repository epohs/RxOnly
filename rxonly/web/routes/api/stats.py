from typing import Any, Optional

from flask import Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp, json_response
from rxonly.web.db import get_db_connection, get_meta, node_where


@api_bp.route("/stats", methods=["GET"])
def get_stats() -> Response:
  """Return dashboard statistics and local node info."""

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    # Get local node ID from meta, already in nodes.node_id's hex format
    local_node_id: Optional[str] = get_meta(conn, "local_node_id")

    # Get local node details
    local_node: Optional[dict[str, Any]] = None
    if local_node_id:
      cur.execute(
        """
        SELECT node_id, short_name, long_name, hardware, role,
               first_seen, last_seen, battery_level, voltage
        FROM nodes
        WHERE node_id = ?
        """,
        (local_node_id,),
      )
      node_row = cur.fetchone()
      if node_row:
        local_node = dict(node_row)
      else:
        # Node not in nodes table yet, return minimal info
        local_node = {"node_id": local_node_id}

    # Count totals.
    #
    # The node count follows the node list: this number is what the sidebar heading
    # reports, so counting rows the list will not show would make `Nodes (84)` name
    # a set the reader cannot page to the end of. The local node above is resolved
    # by id and is deliberately not filtered — the attached device is reported
    # whether or not it has been given a name.
    cur.execute(f"SELECT COUNT(*) AS count FROM nodes {node_where()}")
    total_nodes: int = cur.fetchone()["count"]

    cur.execute("SELECT COUNT(*) AS count FROM messages")
    total_messages: int = cur.fetchone()["count"]

    serve_direct_messages: bool = Config.get("SERVE_DIRECT_MESSAGES", False)
    if serve_direct_messages:
      cur.execute("SELECT COUNT(*) AS count FROM direct_messages")
      total_direct_messages: int = cur.fetchone()["count"]
    else:
      total_direct_messages: int = 0

    cur.execute("SELECT COUNT(*) AS count FROM channels")
    total_channels: int = cur.fetchone()["count"]

    # Get message counts per channel
    cur.execute(
      """
      SELECT c.channel_index, COUNT(m.id) AS message_count
      FROM channels c
      LEFT JOIN messages m ON c.channel_index = m.channel_index
      GROUP BY c.channel_index
      """
    )
    channel_counts: dict[int, int] = {
      row["channel_index"]: row["message_count"]
      for row in cur.fetchall()
    }

    # The newest message in each channel that somebody else sent, as the
    # (rx_time, message_id) pair the sidebar compares a stored read position
    # against. This is what lets `.channel-link` carry `unread`.
    #
    # **The pair, not rx_time alone**, because rx_time is whole seconds off the mesh
    # and ties are ordinary. It is also the pair this app already orders and pages
    # by, and — the part that matters — the pair `mark_read_up_to` uses to decide a
    # single row is read. A sidebar comparing something else could bold a channel
    # every one of whose rows had just been marked read.
    #
    # `message_id` rather than `id` for the tiebreak, for the same reason: the stored
    # position carries `message_id` (it comes off `li.dataset.messageId`), so that is
    # the value there is anything to compare against.
    #
    # **Messages from the local node are excluded, and that is not an optimisation.**
    # A message you sent is not one waiting to be read. mesh-console learned this as a
    # bug — sending on a channel raised its own unread badge — and the exclusion is
    # why this is `_inbound` rather than `_newest`. Skipped entirely when the archive
    # has named no local node: `from_node != NULL` is NULL for every row, which would
    # match nothing and report every channel as read.
    mine = "WHERE from_node != ?" if local_node_id else ""
    params: tuple[Any, ...] = (local_node_id,) if local_node_id else ()

    # ROW_NUMBER over the same ordering rather than MAX(rx_time) with the message_id
    # picked up beside it. SQLite's bare-aggregate rule would hand back *a* row at the
    # maximum rx_time, and which one is unspecified among ties — so on exactly the
    # boundary this pair exists to get right it could return the lower message_id and
    # report an unread message as read.
    cur.execute(
      f"""
      SELECT channel_index, rx_time, message_id
      FROM (
        SELECT channel_index, rx_time, message_id,
               ROW_NUMBER() OVER (
                 PARTITION BY channel_index
                 ORDER BY rx_time DESC, message_id DESC
               ) AS rn
        FROM messages
        {mine}
      )
      WHERE rn = 1
      """,
      params,
    )
    channel_newest_inbound: dict[int, dict[str, int]] = {
      row["channel_index"]: {
        "rx_time": row["rx_time"],
        "message_id": row["message_id"],
      }
      for row in cur.fetchall()
      # A channel whose only traffic is this device's own falls out of the query
      # above; one with a NULL message_id cannot be compared and is no better than
      # absent, so both are simply missing and the client reads that as "nothing
      # waiting".
      if row["message_id"] is not None and row["rx_time"] is not None
    }

    newest_inbound_direct_message: Optional[dict[str, int]] = None
    if serve_direct_messages and local_node_id:
      # The DM index is one thread as far as the sidebar is concerned, so there is no
      # partition here — just the newest inbound row. An outbound DM is excluded on
      # the same grounds as an outbound channel message.
      cur.execute(
        """
        SELECT rx_time, message_id
        FROM direct_messages
        WHERE from_node != ?
        ORDER BY rx_time DESC, message_id DESC
        LIMIT 1
        """,
        (local_node_id,),
      )
      dm_row = cur.fetchone()
      if dm_row and dm_row["message_id"] is not None and dm_row["rx_time"] is not None:
        newest_inbound_direct_message = {
          "rx_time": dm_row["rx_time"],
          "message_id": dm_row["message_id"],
        }

  finally:
    conn.close()

  stats_payload: dict[str, Any] = {
    "total_nodes": total_nodes,
    "total_messages": total_messages,
    "total_channels": total_channels,
    "channel_counts": channel_counts,
    "channel_newest_inbound": channel_newest_inbound,
  }

  if serve_direct_messages:
    stats_payload["total_direct_messages"] = total_direct_messages
    # Present and null when there is no inbound DM, rather than absent: the client
    # distinguishes "nothing waiting" from "this build does not report it", and only
    # the second is a reason to leave the sidebar alone.
    stats_payload["newest_inbound_direct_message"] = newest_inbound_direct_message

  payload: dict[str, Any] = {
    "local_node": local_node,
    "stats": stats_payload,
  }

  return json_response(payload)
