from typing import Any, Optional

from flask import Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp, json_response
from rxonly.web.db import get_db_connection, get_meta, node_where, drawn_rows


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

    # Two DM counts, because the sidebar and the dashboard are asking two questions.
    #
    # `total_direct_messages` is how many rows the archive holds — an archive figure
    # beside `total_messages`, which is the one that matters when thinking about
    # MAX_MESSAGES pruning. `direct_message_count` is how many the DM list will draw,
    # which is what belongs next to a name in the sidebar and is the number that gets
    # bolded. They differ by the folded reactions, and each is right where it is.
    # See `channel_counts` below, which is this same figure per channel.
    serve_direct_messages: bool = Config.get("SERVE_DIRECT_MESSAGES", False)
    if serve_direct_messages:
      cur.execute("SELECT COUNT(*) AS count FROM direct_messages")
      total_direct_messages: int = cur.fetchone()["count"]

      cur.execute(
        f"""
        SELECT COUNT(*) AS count
        FROM direct_messages d
        WHERE {drawn_rows("direct_messages", "d")}
        """
      )
      direct_message_count: int = cur.fetchone()["count"]
    else:
      total_direct_messages: int = 0
      direct_message_count: int = 0

    cur.execute("SELECT COUNT(*) AS count FROM channels")
    total_channels: int = cur.fetchone()["count"]

    # Message counts per channel — rows the channel will *show*, not rows it holds.
    #
    # This number is the one the sidebar bolds, so it has to describe the list it is
    # attached to. Counting every archived row made it describe something else:
    # Primary read `(9)` while the list drew 7, the other two being reactions folded
    # onto their parents. A count that names a set the reader cannot page to the end
    # of is the same mistake `total_nodes` above already avoids.
    #
    # The predicate goes in the ON clause rather than a WHERE so a channel whose rows
    # are all folded away still reports `0` instead of dropping out of the result and
    # leaving the client to fall back on `|| 0`.
    cur.execute(
      f"""
      SELECT c.channel_index, COUNT(m.id) AS message_count
      FROM channels c
      LEFT JOIN messages m
        ON c.channel_index = m.channel_index
       AND {drawn_rows("messages", "m")}
      GROUP BY c.channel_index
      """
    )
    channel_counts: dict[int, int] = {
      row["channel_index"]: row["message_count"]
      for row in cur.fetchall()
    }

    # When each channel last heard from somebody other than this device, as the rx_time
    # the sidebar compares a stored read position against. This is what lets
    # `.channel-link` carry `unread`.
    #
    # **Only rows the list will draw** — see `drawn_rows`. This is the half that was
    # missing and that made the cue unclearable: a reaction is the newest thing in a
    # channel often, and a reaction is never a row anyone can scroll past, so a mark
    # raised by one could never be lowered. Every number in this endpoint that the
    # client compares against a read position, or prints beside a channel name, is
    # over the same set for exactly that reason.
    #
    # **rx_time alone, and the previous version of this carried `(rx_time, message_id)`
    # as a tiebreak on the belief that the pair was an ordering. It is not, and that
    # was a bug with symptoms in both directions.** `message_id` is the mesh packet id —
    # `packet.id`, straight off the radio that sent it — so it is an arbitrary 32-bit
    # number with no relationship to arrival order. Arrival order is `id`, the
    # autoincrement key, which is what every message list sorts by:
    # `ORDER BY m.rx_time, m.id`.
    #
    # So within one whole second — routine, since rx_time has one-second resolution —
    # ranking by message_id picks an arbitrary row rather than the last one. Reported
    # high, a channel read to the end stayed bold and could not be cleared by reading
    # it again, because the client's stored position is the *last row in list order* and
    # that row's packet id may be lower. Reported low, an unread message was hidden.
    # Both were seen against the real archive.
    #
    # Comparing rx_time alone cannot get stuck: the stored position always carries the
    # rx_time of the last row on screen, which is at or after every inbound row's. What
    # it gives up is the tie — an inbound message arriving in the same second as the
    # reader's stored position does not raise the mark, and waits for the next one in a
    # later second. That is a bounded, self-correcting miss rather than a stuck cue.
    # Closing it properly means storing `id` beside `message_id` in the read position,
    # which is a change to read tracking rather than to this endpoint.
    #
    # **Messages from the local node are excluded, and that is not an optimisation.**
    # A message you sent is not one waiting to be read. mesh-console learned this as a
    # bug — sending on a channel raised its own unread badge — and the exclusion is
    # why these are `_inbound` rather than `_newest`. Skipped entirely when the archive
    # has named no local node: `from_node != NULL` is NULL for every row, which would
    # match nothing and report every channel as read.
    drawn = drawn_rows("messages", "m")
    if local_node_id:
      newest_where = f"WHERE m.from_node != ? AND {drawn}"
      params: tuple[Any, ...] = (local_node_id,)
    else:
      newest_where = f"WHERE {drawn}"
      params = ()

    cur.execute(
      f"""
      SELECT m.channel_index, MAX(m.rx_time) AS newest_rx_time
      FROM messages m
      {newest_where}
      GROUP BY m.channel_index
      """,
      params,
    )
    channel_newest_inbound_rx_time: dict[int, int] = {
      row["channel_index"]: row["newest_rx_time"]
      for row in cur.fetchall()
      # A channel whose only traffic is this device's own falls out of the GROUP BY;
      # one whose newest row has no rx_time cannot be compared and is no better than
      # absent. Both are simply missing, and the client reads that as nothing waiting.
      if row["newest_rx_time"] is not None
    }

    newest_inbound_direct_message_rx_time: Optional[int] = None
    if serve_direct_messages and local_node_id:
      # The DM index is one thread as far as the sidebar is concerned, so this is one
      # value rather than a map. An outbound DM is excluded on the same grounds as an
      # outbound channel message, and a folded reaction on the same grounds as a
      # folded reaction in a channel — the DM list is the same list code.
      cur.execute(
        f"""
        SELECT MAX(d.rx_time) AS newest_rx_time
        FROM direct_messages d
        WHERE d.from_node != ?
          AND {drawn_rows("direct_messages", "d")}
        """,
        (local_node_id,),
      )
      dm_row = cur.fetchone()
      if dm_row and dm_row["newest_rx_time"] is not None:
        newest_inbound_direct_message_rx_time = dm_row["newest_rx_time"]

  finally:
    conn.close()

  stats_payload: dict[str, Any] = {
    "total_nodes": total_nodes,
    "total_messages": total_messages,
    "total_channels": total_channels,
    "channel_counts": channel_counts,
    "channel_newest_inbound_rx_time": channel_newest_inbound_rx_time,
  }

  if serve_direct_messages:
    stats_payload["total_direct_messages"] = total_direct_messages
    stats_payload["direct_message_count"] = direct_message_count
    # Present and null when there is no inbound DM, rather than absent: the client
    # distinguishes "nothing waiting" from "this build does not report it", and only
    # the second is a reason to leave the sidebar alone.
    stats_payload["newest_inbound_direct_message_rx_time"] = (
      newest_inbound_direct_message_rx_time
    )

  payload: dict[str, Any] = {
    "local_node": local_node,
    "stats": stats_payload,
  }

  return json_response(payload)
