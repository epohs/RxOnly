import sqlite3

from datetime import datetime
from typing import Any, Optional

from flask import Blueprint, Response, render_template, send_from_directory

from rxonly.config import Config
from rxonly.web.assets import CSS_KEY, JS_KEY, STATIC_DIR, read_manifest
from rxonly.web.db import (
  channel_message_counts,
  direct_message_counts,
  get_db_connection,
  get_meta,
  node_where,
)


dashboard_bp = Blueprint("dashboard", __name__)


@dashboard_bp.route("/favicon.ico")
def favicon() -> Response:
  """The icon a browser asks for without being told to.

  Every favicon the page *links* is under `/static/img/`, so this is only ever hit
  by the implicit request browsers make for `/favicon.ico` at the root — which this
  app answered with a 404 and left to the reverse proxy, where
  `deploy/nginx.conf.example` has an `alias` for it.

  **That made a proxy load-bearing for a response's correctness, which is the thing
  the security headers were just moved here to stop.** nginx serving the file itself
  means `set_security_headers` never runs for it, so on the live site the favicon
  came back with no `X-Content-Type-Options` while every other asset had one — an
  `.ico` is a small thing to sniff, but "every response carries these headers" is
  either true or it is not.

  With this here the app is right on its own, and the proxy's alias is an
  optimisation rather than a requirement. If both exist the proxy still wins, since
  it matches before anything is passed upstream; that is fine, and removing the
  alias is now a free choice rather than a regression.
  """
  return send_from_directory(
    STATIC_DIR / "img", "favicon.ico", mimetype="image/vnd.microsoft.icon"
  )


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


def get_local_node(conn: sqlite3.Connection) -> Optional[dict[str, Any]]:
  """Fetch the local node info using local_node_id from meta table.

  Takes the caller's connection rather than opening one. It used to open its own,
  which meant every dashboard render cost two connections and two sets of startup
  pragmas for one page — the route had already closed the first by the time it got
  here. Reads of a page are one connection's worth of work.
  """
  cur = conn.cursor()

  # meta stores local_node_id in nodes.node_id's hex format
  local_node_id: Optional[str] = get_meta(conn, "local_node_id")
  if local_node_id is None:
    return None

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

    # Channels with the counts their lists will draw, and the two DM figures. Both
    # come from rxonly.web.db, which is where /api/stats gets them too — this
    # renders the sidebar and the fast poll rewrites it ten seconds later, so the
    # two had to agree, and they used to agree by being written out twice with a
    # comment on each saying so. Same reasoning as the node list below.
    channels: list[dict[str, Any]] = channel_message_counts(cur)

    serve_direct_messages: bool = Config.get("SERVE_DIRECT_MESSAGES", False)
    if serve_direct_messages:
      total_direct_messages, direct_message_count = direct_message_counts(cur)
    else:
      total_direct_messages, direct_message_count = 0, 0

    # Fetch nodes (initial page)
    #
    # Filtered by the same clause /api/nodes uses, because this is the same list:
    # the server renders its first page and the API pages it from there. An
    # unfiltered first page would show unnamed nodes until the reader scrolled,
    # at which point they would stop appearing.
    node_list_where: str = node_where()
    cur.execute(
      f"""
      -- No telemetry columns here, on purpose. This page renders a node as a name
      -- and a timestamp; everything else about it arrives through /api/nodes when
      -- the detail pane opens, which is the query that selects the 0.8.0 columns.
      -- Selecting them here would be six columns nothing reads.
      SELECT node_id, short_name, long_name, hardware, role,
             last_seen, battery_level, voltage, snr, rssi,
             latitude, longitude, altitude
      FROM nodes
      {node_list_where}
      ORDER BY last_seen DESC
      LIMIT 50
      """
    )
    nodes: list[dict[str, Any]] = [dict(row) for row in cur.fetchall()]

    # Get total node count for pagination info — the same clause again, so the
    # number the page pages towards is the number of rows it can reach.
    cur.execute(f"SELECT COUNT(*) AS count FROM nodes {node_list_where}")
    total_nodes: int = cur.fetchone()["count"]

    # Get total message count for dashboard stats
    cur.execute("SELECT COUNT(*) AS count FROM messages")
    total_messages: int = cur.fetchone()["count"]

    # Get total channel count for dashboard stats
    cur.execute("SELECT COUNT(*) AS count FROM channels")
    total_channels: int = cur.fetchone()["count"]

    # Inside the connection, deliberately. This was below, after the close, and
    # opened a second connection of its own to answer one question about one row.
    local_node: Optional[dict[str, Any]] = get_local_node(conn)

  finally:
    conn.close()

  # Minified asset filenames for cache-busted includes. These come from the
  # build manifest, not the archive — the templates fall back to unminified
  # sources when there is no build.
  manifest = read_manifest()
  css_filename: Optional[str] = manifest.get(CSS_KEY)
  js_filename: Optional[str] = manifest.get(JS_KEY)

  device_name: str = format_device_name(local_node)

  return render_template(
    "index.html",
    device_name=device_name,
    channels=channels,
    nodes=nodes,
    total_nodes=total_nodes,
    total_direct_messages=total_direct_messages,
    direct_message_count=direct_message_count,
    serve_direct_messages=serve_direct_messages,
    local_node=local_node,
    total_messages=total_messages,
    total_channels=total_channels,
    debug=Config.get("DEBUG", False),
    css_filename=css_filename,
    js_filename=js_filename,
  )
