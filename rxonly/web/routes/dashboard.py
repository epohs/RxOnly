from datetime import datetime
from typing import Any, Optional

from flask import Blueprint, render_template

from rxonly.config import Config
from rxonly.web.db import get_db_connection


dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.app_template_filter("format_timestamp")
def format_timestamp_filter(unix_timestamp: Optional[int]) -> str:
  """Convert unix timestamp to human-readable format (matches JS toLocaleString)."""
  if unix_timestamp is None:
    return ""
  try:
    dt = datetime.fromtimestamp(unix_timestamp)
    # Format: M/D/YYYY, H:MM:SS AM/PM (matches JS toLocaleString en-US)
    return dt.strftime("%-m/%-d/%Y, %-I:%M:%S %p")
  except (ValueError, TypeError, OSError):
    return ""


@dashboard_bp.app_template_filter("format_iso_timestamp")
def format_iso_timestamp_filter(unix_timestamp: Optional[int]) -> str:
  """Convert unix timestamp to ISO 8601 format for datetime attributes."""
  if unix_timestamp is None:
    return ""
  try:
    dt = datetime.fromtimestamp(unix_timestamp)
    return dt.isoformat()
  except (ValueError, TypeError, OSError):
    return ""


def node_num_to_hex_id(node_num: str) -> str:
  """Convert decimal nodeNum to hex node_id format (e.g., '1234567890' -> '!499602d2')."""
  try:
    num = int(node_num)
    return f"!{num & 0xFFFFFFFF:08x}"
  except (ValueError, TypeError):
    return node_num


def get_local_node() -> Optional[dict[str, Any]]:
  """Fetch the local node info using local_node_id from meta table."""
  conn = get_db_connection()
  try:
    cur = conn.cursor()

    cur.execute("SELECT value FROM meta WHERE key = 'local_node_id'")
    row = cur.fetchone()
    if row is None:
      return None

    # meta table stores decimal nodeNum, nodes table uses hex format
    local_node_num: str = row["value"]
    local_node_id: str = node_num_to_hex_id(local_node_num)

    cur.execute(
      """
      SELECT node_id, short_name, long_name, hardware, role,
             first_seen, last_seen, battery_level, voltage, snr, rssi,
             latitude, longitude, altitude
      FROM nodes
      WHERE node_id = ?
      """,
      (local_node_id,),
    )

    node_row = cur.fetchone()
    if node_row is None:
      return {"node_id": local_node_id}

    return dict(node_row)
  finally:
    conn.close()


def format_device_name(node: Optional[dict[str, Any]]) -> str:
  """Format device name as 'long_name (short_name)' or node_id fallback."""
  if node is None:
    return "Unknown Device"

  long_name: Optional[str] = node.get("long_name")
  short_name: Optional[str] = node.get("short_name")
  node_id: str = node.get("node_id", "Unknown")

  if long_name and short_name:
    return f"{long_name} ({short_name})"
  elif long_name:
    return long_name
  elif short_name:
    return short_name
  else:
    return node_id


@dashboard_bp.route("/")
def index() -> str:
  conn = get_db_connection()
  try:
    cur = conn.cursor()

    # Fetch channels with message counts
    cur.execute(
      """
      SELECT c.channel_index, c.name, COUNT(m.id) AS message_count
      FROM channels c
      LEFT JOIN messages m ON c.channel_index = m.channel_index
      GROUP BY c.channel_index, c.name
      ORDER BY c.channel_index
      """
    )
    channels: list[dict[str, Any]] = [dict(row) for row in cur.fetchall()]

    # Get direct message count (only if logging is enabled)
    log_direct_messages: bool = Config.get("LOG_DIRECT_MESSAGES", False)
    if log_direct_messages:
      cur.execute("SELECT COUNT(*) AS count FROM direct_messages")
      total_direct_messages: int = cur.fetchone()["count"]
    else:
      total_direct_messages: int = 0

    # Fetch nodes (initial page)
    cur.execute(
      """
      SELECT node_id, short_name, long_name, hardware, role,
             last_seen, battery_level, voltage, snr, rssi,
             latitude, longitude, altitude
      FROM nodes
      ORDER BY last_seen DESC
      LIMIT 50
      """
    )
    nodes: list[dict[str, Any]] = [dict(row) for row in cur.fetchall()]

    # Get total node count for pagination info
    cur.execute("SELECT COUNT(*) AS count FROM nodes")
    total_nodes: int = cur.fetchone()["count"]

    # Get total message count for dashboard stats
    cur.execute("SELECT COUNT(*) AS count FROM messages")
    total_messages: int = cur.fetchone()["count"]

    # Get total channel count for dashboard stats
    cur.execute("SELECT COUNT(*) AS count FROM channels")
    total_channels: int = cur.fetchone()["count"]

  finally:
    conn.close()

  local_node: Optional[dict[str, Any]] = get_local_node()
  device_name: str = format_device_name(local_node)

  return render_template(
    "index.html",
    device_name=device_name,
    channels=channels,
    nodes=nodes,
    total_nodes=total_nodes,
    total_direct_messages=total_direct_messages,
    log_direct_messages=log_direct_messages,
    local_node=local_node,
    total_messages=total_messages,
    total_channels=total_channels,
    debug=Config.get("DEBUG", False),
  )
