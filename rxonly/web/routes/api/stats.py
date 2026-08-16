from typing import Any, Optional

from flask import Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp, json_response
from rxonly.web.db import (
  channel_message_counts,
  direct_message_counts,
  drawn_rows,
  get_db_connection,
  get_meta,
  node_where,
)


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
    # Both come from `direct_message_counts`, which is also what the dashboard route
    # renders its first paint from — see there for what each one means and why they
    # differ. Whether to ask at all stays here: exposing direct messages is this
    # process's decision, and defaults to no regardless of what the archive holds.
    serve_direct_messages: bool = Config.get("SERVE_DIRECT_MESSAGES", False)
    if serve_direct_messages:
      total_direct_messages, direct_message_count = direct_message_counts(cur)
    else:
      total_direct_messages, direct_message_count = 0, 0

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
    # `channel_message_counts` carries the channel's name as well, which this
    # endpoint has no use for and drops; the dashboard route renders it. One query
    # in one place rather than two spellings of it — see rxonly/web/db.py.
    channel_counts: dict[int, int] = {
      row["channel_index"]: row["message_count"]
      for row in channel_message_counts(cur)
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

    peer_newest_inbound_rx_time: dict[str, int] = {}
    if serve_direct_messages and local_node_id:
      # Per peer, because the DM view is threaded and each thread carries its own
      # read position (`rxonly_last_read_dm_<peer>`). This was one value when the
      # DM list was one flat thread; a scalar cannot say "conversation B is still
      # waiting" once reading conversation A no longer reads B. The channel map
      # above is the same shape keyed by channel_index; this is it keyed by peer.
      #
      # An outbound DM is excluded on the same grounds as an outbound channel
      # message, and a folded reaction on the same grounds as a folded reaction
      # in a channel — a thread is the same list code. And because only inbound
      # rows are asked about, the peer needs no CASE: the collector archives an
      # inbound DM only when it is addressed to the local node, so the sender
      # *is* the other end of the thread by construction. A NULL from_node fails
      # `!= ?` and drops out, which is right — a row with no sender cannot be
      # attributed to a conversation, let alone be waiting in one.
      cur.execute(
        f"""
        SELECT d.from_node AS peer, MAX(d.rx_time) AS newest_rx_time
        FROM direct_messages d
        WHERE d.from_node != ?
          AND {drawn_rows("direct_messages", "d")}
        GROUP BY d.from_node
        """,
        (local_node_id,),
      )
      peer_newest_inbound_rx_time = {
        row["peer"]: row["newest_rx_time"]
        for row in cur.fetchall()
        if row["newest_rx_time"] is not None
      }

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
    # Present and empty when there is no inbound DM, rather than absent: the client
    # distinguishes "nothing waiting" from "this build does not report it", and only
    # the second is a reason to leave the sidebar alone. This key replaced the
    # scalar `newest_inbound_direct_message_rx_time` when the DM view was threaded;
    # a client still looking for the scalar reads its absence as "not reported" and
    # abstains, which is the graceful half of that distinction.
    stats_payload["peer_newest_inbound_rx_time"] = peer_newest_inbound_rx_time

  payload: dict[str, Any] = {
    "local_node": local_node,
    "stats": stats_payload,
  }

  return json_response(payload)
