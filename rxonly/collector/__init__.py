from __future__ import annotations

import logging
import os
import signal
import sys
import time
import sqlite3

from typing import Optional

from meshtastic.serial_interface import SerialInterface
from pubsub import pub

from rxonly.config import Config
from rxonly.db import Storage


LOG_FORMAT = "[%(levelname)s] %(message)s"




class MeshtasticCollector:
  """
  Collects Meshtastic packets via serial interface and persists
  node metadata, channel messages, and direct messages to SQLite.
  """

  def __init__(self, db: Storage) -> None:
    self.storage = db
    self.serial_port: str = Config.get("SERIAL_PORT")
    self.interface: Optional[SerialInterface] = None
    self._running = False
    self.local_node_id: Optional[str] = None




  def start(self) -> None:
    logging.info("Starting Meshtastic collector on %s", self.serial_port)

    self.interface = SerialInterface(self.serial_port)

    self._sync_channels()
    self._initial_node_sync()

    self.local_node_id = str(self.interface.localNode.nodeNum)
    stored_node_id = self.storage.get_meta("local_node_id")

    if stored_node_id != self.local_node_id:
      logging.warning(
        "Device swap detected (stored=%s, current=%s)",
        stored_node_id,
        self.local_node_id,
      )
      self.storage.set_meta("local_node_id", self.local_node_id)
      self._restart_process()

    self.storage.set_meta("local_node_id", self.local_node_id)
    self.storage.prune_stale_nodes()

    pub.subscribe(self._on_receive, "meshtastic.receive")
    pub.subscribe(self._on_node_update, "meshtastic.node.updated")

    self._running = True
    self._main_loop()




  def stop(self) -> None:
    logging.info("Stopping collector")
    self._running = False
    if self.interface:
      self.interface.close()
    self.storage.close()




  def _main_loop(self) -> None:
    while self._running:
      time.sleep(1)




  def _on_receive(self, packet: dict, interface=None) -> None:
    """
    Handle incoming Meshtastic packets.
    Normalizes packet data and routes to appropriate handler.
    """
    if not self._running or not getattr(self.storage, "conn", None):
      return

    decoded = packet.get("decoded")
    if not decoded:
      return

    from_node_id = packet.get("fromId")
    if not from_node_id:
      raw_from = packet.get("from")
      if raw_from:
        from_node_id = f"!{raw_from & 0xFFFFFFFF:08x}"

    if not from_node_id:
      logging.debug("Packet without node_id; skipping")
      return

    portnum = decoded.get("portnum")

    # TEXT_MESSAGE_APP may not always have a reliable portnum
    text = decoded.get("text")
    if text:
      self._handle_text_message(packet, from_node_id)
      return

    try:
      existing = self.storage.get_node(from_node_id)
    except sqlite3.ProgrammingError as e:
      logging.debug("Database unavailable during packet processing: %s", e)
      raise

    if not existing and portnum not in ("NODEINFO_APP", "TEXT_MESSAGE_APP"):
      logging.debug("Skip: %s (unknown node, waiting for NODEINFO)", from_node_id)
      return

    # Normalize packet into node_data shape
    normalized = {
      "user": {"id": from_node_id},
      "decoded": decoded,
      "snr": packet.get("rxSnr") or packet.get("snr"),
      "rssi": packet.get("rxRssi") or packet.get("rx_rssi"),
      "_source": "packet",
    }

    if portnum == "TELEMETRY_APP":
      metrics = decoded.get("telemetry", {}).get("deviceMetrics", {})
      normalized["deviceMetrics"] = {
        "batteryLevel": metrics.get("batteryLevel"),
        "voltage": metrics.get("voltage"),
      }

    elif portnum == "POSITION_APP":
      pos = decoded.get("position", {})
      normalized["position"] = {
        "latitude": pos.get("latitude"),
        "longitude": pos.get("longitude"),
        "altitude": pos.get("altitude"),
      }

    elif portnum == "NODEINFO_APP":
      user = decoded.get("user", {})
      normalized["user"] = {
        "id": user.get("id") or from_node_id,
        "longName": user.get("longName"),
        "shortName": user.get("shortName"),
        "hwModel": user.get("hwModel"),
        "role": user.get("role"),
      }

    elif portnum == "TEXT_MESSAGE_APP":
      self._handle_text_message(packet, from_node_id)
      return

    self._on_node_update(normalized)




  def _initial_node_sync(self) -> None:
    """Sync all known nodes from device into database at startup."""
    if not self.interface:
      logging.warning("No interface available for initial node sync")
      return

    logging.info("Starting initial node sync for %d nodes", len(self.interface.nodes))

    for node_id, node in self.interface.nodes.items():
      try:
        self._on_node_update(node, from_initial_sync=True)
      except Exception:
        logging.exception("Error during initial sync for node_id=%s", node_id)

    logging.info("Initial node sync complete")




  def _on_node_update(self, node_data: dict, from_initial_sync: bool = False) -> None:
    """
    Update node record in database.
    Accepts full NODEINFO or partial updates (POSITION_APP, TELEMETRY_APP).
    """
    user_data = node_data.get("user", {})
    node_id = str(user_data.get("id") or node_data.get("id"))

    decoded = node_data.get("decoded", {})
    portnum = decoded.get("portnum")

    identity_allowed = from_initial_sync or portnum == "NODEINFO_APP"

    if not node_id:
      logging.warning(
        "Received node data without id (snippet: %s)",
        repr(node_data)[:200],
      )
      return

    has_identity = bool(
      user_data.get("longName")
      or user_data.get("shortName")
      or user_data.get("hwModel")
      or user_data.get("role")
      or user_data.get("publicKey")
    )

    existing = self.storage.get_node(node_id) or {}
    is_new_node = not existing

    if is_new_node:
      if not identity_allowed:
        logging.debug("Ignoring %s update for unknown node %s", portnum, node_id)
        return
      if not has_identity:
        logging.debug("Ignoring identity-less NODEINFO for node %s", node_id)
        return

    device_metrics = node_data.get("deviceMetrics", {})
    position = node_data.get("position", {})

    merged = self._merge_node_data(node_id, {
      "short_name": user_data.get("shortName"),
      "long_name": user_data.get("longName"),
      "hardware": user_data.get("hwModel"),
      "role": user_data.get("role"),
      "snr": node_data.get("snr"),
      "rssi": node_data.get("rssi"),
      "battery_level": device_metrics.get("batteryLevel"),
      "voltage": device_metrics.get("voltage"),
      "latitude": position.get("latitude"),
      "longitude": position.get("longitude"),
      "altitude": position.get("altitude"),
    })

    self.storage.upsert_node(node_id=node_id, **merged)

    if from_initial_sync:
      logging.debug("Initial sync: node %s inserted/updated", node_id)
      return

    # Log new node discovery with initial data
    if is_new_node:
      initial_data = {k: v for k, v in merged.items() if v is not None and k != "last_seen"}
      logging.info("New node discovered: %s %s", node_id, initial_data)
      return

    # Log only fields that actually changed for existing nodes
    changed = {}
    for key in (
      "short_name", "long_name", "hardware", "role",
      "battery_level", "voltage", "snr", "rssi",
      "latitude", "longitude", "altitude",
    ):
      old = existing.get(key)
      new = merged.get(key)
      if old != new:
        changed[key] = new

    if changed:
      logging.info("Node %s updated: %s", node_id, changed)
    else:
      logging.debug("Skip: %s (no changes)", node_id)




  def _handle_text_message(self, packet: dict, from_node_id: str) -> None:
    """Route TEXT_MESSAGE_APP packets to channel or DM storage."""
    decoded = packet.get("decoded", {})
    text = decoded.get("text", "")

    logging.debug(
      "Captured text message from=%s channel=%s text=%r",
      from_node_id,
      packet.get("channel"),
      text
    )

    if not text:
      logging.debug("Skip: empty text message from %s", from_node_id)
      return

    to_id = packet.get("toId")
    message_id = packet.get("id", 0)
    rx_time = packet.get("rxTime", int(time.time()))
    snr = packet.get("rxSnr")
    rssi = packet.get("rxRssi")
    hop_start = packet.get("hopStart")
    hop_limit = packet.get("hopLimit")
    hop_count = (hop_start - hop_limit) if hop_start and hop_limit else None
    channel_index = packet.get("channel", 0)
    reply_to = decoded.get("replyId")
    via_mqtt = packet.get("viaMqtt", False)

    # Determine if DM or channel message
    local_hex_id = f"!{int(self.local_node_id) & 0xFFFFFFFF:08x}" if self.local_node_id else None
    is_dm = (
      to_id is not None
      and to_id != "^all"
      and to_id == local_hex_id
    )

    if is_dm:
      if not Config.get("LOG_DIRECT_MESSAGES"):
        logging.debug("Skip: direct message logging disabled")
        return

      try:
        inserted = self.storage.insert_direct_message(
          message_id=message_id,
          from_node=from_node_id,
          text=text,
          rx_time=rx_time,
          snr=snr,
          rssi=rssi,
          reply_to=reply_to,
          via_mqtt=via_mqtt,
        )
        if inserted:
          logging.info("DM from %s: %s", from_node_id, text[:100])
        else:
          logging.debug("Duplicate DM skipped: message_id=%s", message_id)
      except Exception:
        logging.exception("Failed to insert DM from %s", from_node_id)
    else:
      if not self._should_log_channel(channel_index):
        logging.debug("Skip: message on untracked channel %d", channel_index)
        return

      try:
        inserted = self.storage.insert_message(
          message_id=message_id,
          channel_index=channel_index,
          from_node=from_node_id,
          to_node=to_id,
          text=text,
          rx_time=rx_time,
          hop_count=hop_count,
          snr=snr,
          rssi=rssi,
          reply_to=reply_to,
          via_mqtt=via_mqtt,
        )
        if inserted:
          logging.info("CH%d %s: %s", channel_index, from_node_id, text[:100])
        else:
          logging.debug("Duplicate message skipped: message_id=%s", message_id)
      except Exception:
        logging.exception("Failed to insert message from %s", from_node_id)




  def _merge_node_data(self, node_id: str, new_data: dict) -> dict:
    """Merge incoming node data with existing DB record, preferring new non-null values."""
    row = self.storage.get_node(node_id) or {}
    merged = {}

    fields = [
      "short_name", "long_name", "hardware", "role",
      "last_seen", "battery_level", "voltage", "snr", "rssi",
      "latitude", "longitude", "altitude"
    ]

    for field in fields:
      if field in new_data and new_data[field] is not None:
        merged[field] = new_data[field]
      else:
        merged[field] = row.get(field)

    merged["last_seen"] = new_data.get("last_seen", int(time.time()))
    return merged




  def _sync_channels(self) -> None:
    """
    Sync channels from device into database.
    Channels tracked: PRIMARY_CHANNEL if LOG_PRIMARY_CHANNEL=True, plus any in LOG_CHANNEL_IDS.
    """
    primary_channel = Config.get("PRIMARY_CHANNEL", 0)
    logging.info(
      "Channel config: LOG_PRIMARY_CHANNEL=%s PRIMARY_CHANNEL=%s LOG_CHANNEL_IDS=%s",
      Config.get("LOG_PRIMARY_CHANNEL"),
      primary_channel,
      Config.get("LOG_CHANNEL_IDS"),
    )

    try:
      local_node = self.interface.getNode("^local")
      if not local_node:
        logging.warning("No local node available; cannot sync channels")
        return

      channels = getattr(local_node, "channels", None)
      if channels is None:
        logging.warning("Local node has no channels list")
        channels = []

      device_channels = {}
      for ch in channels:
        idx = getattr(ch, "index", None)
        if isinstance(idx, int):
          device_channels[idx] = ch

      tracked_indexes = set()

      if Config.get("LOG_PRIMARY_CHANNEL", True):
        tracked_indexes.add(primary_channel)

      configured = Config.get("LOG_CHANNEL_IDS", [])
      if configured:
        tracked_indexes.update(configured)

      logging.info("Config-tracked channel indexes: %s", sorted(tracked_indexes))

      for idx in sorted(tracked_indexes):
        ch = device_channels.get(idx)

        name = None
        if ch:
          settings = getattr(ch, "settings", None)
          if settings:
            raw_name = getattr(settings, "name", None)
            if raw_name and raw_name.strip():
              name = raw_name.strip()

        if not name:
          name = f"Channel {idx}"

        logging.info("Tracking channel: index=%s name=%s", idx, name)
        self.storage.upsert_channel(idx, name)

      logging.info("Channels synced successfully")

    except Exception:
      logging.exception("Failed to sync channels")




  def _should_log_channel(self, channel_index: int) -> bool:
    """Check if channel_index is configured for logging."""
    primary_channel = Config.get("PRIMARY_CHANNEL", 0)
    if Config.get("LOG_PRIMARY_CHANNEL") and channel_index == primary_channel:
      return True

    allowed_channels = Config.get("LOG_CHANNEL_IDS") or []
    if channel_index in allowed_channels:
      return True

    return False




  def _restart_process(self) -> None:
    """Restart collector after device swap detection."""
    import __main__

    if hasattr(__main__, "__package__") and __main__.__package__:
      os.execv(sys.executable, [sys.executable, "-m", __main__.__package__] + sys.argv[1:])
    else:
      os.execv(sys.executable, [sys.executable] + sys.argv)




def _configure_logging() -> None:
  log_level = logging.DEBUG if Config.get("DEBUG", False) else logging.INFO
  logging.basicConfig(level=log_level, format=LOG_FORMAT)




def _install_signal_handlers(collector: MeshtasticCollector) -> None:
  def _handle_signal(signum, frame):
    collector.stop()
    sys.exit(0)

  signal.signal(signal.SIGINT, _handle_signal)
  signal.signal(signal.SIGTERM, _handle_signal)




def main() -> None:
  Config.load()
  _configure_logging()

  db = Storage()

  collector = MeshtasticCollector(db=db)
  _install_signal_handlers(collector)
  collector.start()




if __name__ == "__main__":
  main()
