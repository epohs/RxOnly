import json
from typing import Any, Optional

from flask import Response

from rxonly.config import Config
from rxonly.web.routes.api import api_bp
from rxonly.web.db import get_db_connection


def node_num_to_hex_id(node_num: str) -> str:
  """Convert decimal nodeNum to hex node_id format (e.g., '1234567890' -> '!499602d2')."""
  try:
    num = int(node_num)
    return f"!{num & 0xFFFFFFFF:08x}"
  except (ValueError, TypeError):
    return node_num


@api_bp.route("/stats", methods=["GET"])
def get_stats() -> Response:
  """Return dashboard statistics and local node info."""

  conn = get_db_connection()
  try:
    cur = conn.cursor()

    # Get local node ID from meta
    cur.execute("SELECT value FROM meta WHERE key = 'local_node_id'")
    row = cur.fetchone()
    local_node_num: Optional[str] = row["value"] if row else None
    local_node_id: Optional[str] = node_num_to_hex_id(local_node_num) if local_node_num else None

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

    # Count totals
    cur.execute("SELECT COUNT(*) AS count FROM nodes")
    total_nodes: int = cur.fetchone()["count"]

    cur.execute("SELECT COUNT(*) AS count FROM messages")
    total_messages: int = cur.fetchone()["count"]

    log_direct_messages: bool = Config.get("LOG_DIRECT_MESSAGES", False)
    if log_direct_messages:
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

  finally:
    conn.close()

  stats_payload: dict[str, Any] = {
    "total_nodes": total_nodes,
    "total_messages": total_messages,
    "total_channels": total_channels,
    "channel_counts": channel_counts,
  }

  if log_direct_messages:
    stats_payload["total_direct_messages"] = total_direct_messages

  payload: dict[str, Any] = {
    "local_node": local_node,
    "stats": stats_payload,
  }

  return Response(
    json.dumps(payload, indent=2),
    mimetype="application/json",
  )
