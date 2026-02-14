from __future__ import annotations

import logging
import sqlite3
import time

from pathlib import Path
from typing import Optional

from rxonly.config import Config


SCHEMA_FILE = Path(__file__).parent / "schema.sql"




class Storage:
  """SQLite storage layer for nodes, messages, and direct messages."""

  def __init__(self) -> None:
    self.db_path = Path(Config.get("DB_PATH"))
    self.db_path.parent.mkdir(parents=True, exist_ok=True)

    self.conn = sqlite3.connect(
      self.db_path,
      check_same_thread=False,
    )
    self.conn.row_factory = sqlite3.Row

    with self.conn:
      self.conn.execute("PRAGMA foreign_keys = ON;")
      self.conn.execute("PRAGMA journal_mode = WAL;")
      self.conn.execute("PRAGMA synchronous = NORMAL;")
      self.conn.execute("PRAGMA busy_timeout = 3000;")

    self._initialize_or_upgrade_database()

    self._node_insert_count = 0
    self._message_insert_count = 0
    self._dm_insert_count = 0
    self._prune_interval = Config.get("PRUNE_INTERVAL")




  def _read_schema_version(self) -> str:
    with open(SCHEMA_FILE, "r") as f:
      first_line = f.readline().strip()
    if first_line.startswith("-- schema_version:"):
      return first_line.split(":", 1)[1].strip()
    return "0.0.0"




  def _get_db_schema_version(self) -> str:
    try:
      row = self.conn.execute(
        "SELECT value FROM meta WHERE key='schema_version';"
      ).fetchone()
      return row["value"] if row else "0.0.0"
    except sqlite3.OperationalError:
      return "0.0.0"




  def _initialize_or_upgrade_database(self) -> None:
    """Rebuild database if schema version has changed."""
    schema_version = self._read_schema_version()
    db_version = self._get_db_schema_version()

    if schema_version == db_version:
      return

    logging.info("Initializing/upgrading database: %s -> %s", db_version, schema_version)

    with open(SCHEMA_FILE, "r") as f:
      sql_script = f.read()

    with self.conn:
      if db_version != "0.0.0":
        existing_tables = self.conn.execute(
          "SELECT name FROM sqlite_master WHERE type='table';"
        ).fetchall()
        for row in existing_tables:
          table_name = row["name"]
          if table_name.startswith("sqlite_"):
            continue
          logging.info("Dropping table %s", table_name)
          self.conn.execute(f"DROP TABLE IF EXISTS {table_name};")

      logging.info("Rebuilding database schema")
      self.conn.executescript(sql_script)

      self.conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
        (schema_version,)
      )

    logging.info("Database initialized/upgraded successfully")




  def get_meta(self, key: str) -> Optional[str]:
    row = self.conn.execute(
      "SELECT value FROM meta WHERE key = ?", (key,)
    ).fetchone()
    return row["value"] if row else None




  def set_meta(self, key: str, value: str) -> None:
    with self.conn:
      self.conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        (key, value),
      )




  def upsert_channel(self, channel_index: int, name: str) -> None:
    """Insert or update a channel."""
    try:
      with self.conn:
        self.conn.execute(
          """INSERT INTO channels (channel_index, name)
             VALUES (?, ?)
             ON CONFLICT(channel_index) DO UPDATE SET
             name = excluded.name""",
          (channel_index, name)
        )
    except Exception:
      logging.exception("Failed to upsert channel")




  def insert_message(
    self,
    message_id: int,
    channel_index: int,
    from_node: str,
    to_node: Optional[str],
    text: str,
    rx_time: int,
    hop_count: Optional[int],
    snr: Optional[float],
    rssi: Optional[int],
    reply_to: Optional[int] = None,
    via_mqtt: bool = False,
  ) -> bool:
    """Insert channel message and periodically prune old messages.

    Returns True if inserted, False if duplicate.
    """
    with self.conn:
      cursor = self.conn.execute(
        """INSERT OR IGNORE INTO messages
           (message_id, channel_index, from_node, to_node, text, rx_time, hop_count, snr, rssi, reply_to, via_mqtt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (message_id, channel_index, from_node, to_node, text, rx_time, hop_count, snr, rssi, reply_to, int(via_mqtt)),
      )
      inserted = cursor.rowcount > 0

    if inserted:
      self._message_insert_count += 1
      if self._message_insert_count >= self._prune_interval:
        self._prune_messages()
        self._message_insert_count = 0

    return inserted




  def insert_direct_message(
    self,
    message_id: int,
    from_node: str,
    text: str,
    rx_time: int,
    snr: Optional[float],
    rssi: Optional[int],
    reply_to: Optional[int] = None,
    via_mqtt: bool = False,
  ) -> bool:
    """Insert direct message and periodically prune old messages.

    Returns True if inserted, False if duplicate.
    """
    with self.conn:
      cursor = self.conn.execute(
        """INSERT OR IGNORE INTO direct_messages
           (message_id, from_node, text, rx_time, snr, rssi, reply_to, via_mqtt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (message_id, from_node, text, rx_time, snr, rssi, reply_to, int(via_mqtt)),
      )
      inserted = cursor.rowcount > 0

    if inserted:
      self._dm_insert_count += 1
      if self._dm_insert_count >= self._prune_interval:
        self._prune_direct_messages()
        self._dm_insert_count = 0

    return inserted




  def get_node(self, node_id: str) -> Optional[dict]:
    """Retrieve a node by its node_id."""
    row = self.conn.execute(
      "SELECT * FROM nodes WHERE node_id = ?", (node_id,)
    ).fetchone()
    return dict(row) if row else None




  def upsert_node(
    self,
    node_id: str,
    short_name: Optional[str],
    long_name: Optional[str],
    hardware: Optional[str],
    role: Optional[str],
    last_seen: int,
    battery_level: Optional[int],
    voltage: Optional[float],
    snr: Optional[float],
    rssi: Optional[int],
    latitude: Optional[float],
    longitude: Optional[float],
    altitude: Optional[int]
  ) -> None:
    """Insert or update a node, preserving non-null existing values."""
    with self.conn:
      cursor = self.conn.execute(
        """INSERT INTO nodes
           (node_id, short_name, long_name, hardware, role, last_seen,
            battery_level, voltage, snr, rssi, latitude, longitude, altitude)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
           short_name = COALESCE(excluded.short_name, short_name),
           long_name = COALESCE(excluded.long_name, long_name),
           hardware = COALESCE(excluded.hardware, hardware),
           role = COALESCE(excluded.role, role),
           last_seen = excluded.last_seen,
           battery_level = COALESCE(excluded.battery_level, battery_level),
           voltage = COALESCE(excluded.voltage, voltage),
           snr = COALESCE(excluded.snr, snr),
           rssi = COALESCE(excluded.rssi, rssi),
           latitude = COALESCE(excluded.latitude, latitude),
           longitude = COALESCE(excluded.longitude, longitude),
           altitude = COALESCE(excluded.altitude, altitude)
        """,
        (
          node_id, short_name, long_name, hardware, role, last_seen,
          battery_level, voltage, snr, rssi, latitude, longitude, altitude,
        ),
      )
      inserted = cursor.rowcount > 0

    if inserted:
      self._node_insert_count += 1
      if self._node_insert_count >= self._prune_interval:
        self.prune_stale_nodes()
        self._node_insert_count = 0




  def _prune_messages(self) -> None:
    """Delete channel messages beyond MAX_MESSAGES limit."""
    max_messages = Config.get("MAX_MESSAGES")
    with self.conn:
      deleted = self.conn.execute(
        """DELETE FROM messages
           WHERE id NOT IN (
               SELECT id FROM messages
               ORDER BY rx_time DESC
               LIMIT ?
           )""",
        (max_messages,),
      ).rowcount
      
    if deleted:
      noun = "Message" if deleted == 1 else "Messages"
      logging.info("%d %s pruned", deleted, noun)  


  def _prune_direct_messages(self) -> None:
    """Delete direct messages beyond MAX_DIRECT_MESSAGES limit."""
    max_dm = Config.get("MAX_DIRECT_MESSAGES")
    with self.conn:
      deleted = self.conn.execute(
        """DELETE FROM direct_messages
           WHERE id NOT IN (
               SELECT id FROM direct_messages
               ORDER BY rx_time DESC
               LIMIT ?
           )""",
        (max_dm,),
      ).rowcount
      
    if deleted:
      noun = "Direct message" if deleted == 1 else "Direct messages"
      logging.info("%d %s pruned", deleted, noun)      


  def prune_stale_nodes(self) -> None:
    """Delete nodes not seen within NODE_PRUNE_DAYS."""
    cutoff = int(time.time()) - (Config.get("NODE_PRUNE_DAYS") * 86400)
    with self.conn:
      deleted = self.conn.execute("DELETE FROM nodes WHERE last_seen < ?", (cutoff,)).rowcount

      if deleted:
        noun = "Node" if deleted == 1 else "Nodes"
        logging.info("%d %s pruned", deleted, noun)




  def close(self) -> None:
    self.conn.close()
