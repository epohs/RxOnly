from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


DEFAULT_CONFIG = {
  "DEBUG": False,                # Enable verbose logging and disable css/js minification
  "DB_PATH": "data/db.sqlite",   # Path to SqLite database
  "MAX_MESSAGES": 1000,          # Max channel messages to keep across all channels
  "MAX_DIRECT_MESSAGES": 1000,   # Max direct messages to keep
  "PRUNE_INTERVAL": 5,           # Only attempt pruning every X writes
  "NODE_PRUNE_DAYS": 14,         # Nodes unseen in X days will be pruned
  "SERIAL_PORT": "/dev/ttyACM0", # Meshtastic serial device location
  "LOG_DIRECT_MESSAGES": False,  # Should we store direct messages
  "LOG_PRIMARY_CHANNEL": True,   # Should we track primary channel messages
  "PRIMARY_CHANNEL": 0,          # Primary channel index (usually 0)
  "LOG_CHANNEL_IDS": [],         # Additional channel indexes to track
}

CONFIG_FILE_PATH = Path(__file__).parent / "config.json"
SAMPLE_CONFIG_FILE_PATH = Path(__file__).parent / "config-sample.json"




class Config:
  """
  Central configuration loader.
  Priority: environment variables > config.json > defaults.
  """

  values: dict[str, Any] = {}
  _loaded: bool = False




  @classmethod
  def load(cls) -> None:
    """Load configuration values. Only runs once."""
    if cls._loaded:
      return

    cls.values = DEFAULT_CONFIG.copy()

    if CONFIG_FILE_PATH.exists():
      try:
        with open(CONFIG_FILE_PATH, "r") as f:
          file_config = json.load(f)
          cls.values.update(file_config)
      except Exception as e:
        print(f"Warning: Failed to read {CONFIG_FILE_PATH}: {e}")

    for key, default_val in DEFAULT_CONFIG.items():
      env_val = os.getenv(key)
      if env_val is not None:
        try:
          cls.values[key] = cls._cast_env_value(env_val, default_val)
        except Exception:
          print(f"Warning: Could not cast environment variable {key}='{env_val}'")

    if "LOG_PRIMARY_CHANNEL" not in cls.values or cls.values["LOG_PRIMARY_CHANNEL"] is None:
      cls.values["LOG_PRIMARY_CHANNEL"] = True
    if "LOG_CHANNEL_IDS" not in cls.values or cls.values["LOG_CHANNEL_IDS"] is None:
      cls.values["LOG_CHANNEL_IDS"] = []

    cls._loaded = True




  @classmethod
  def get(cls, key: str, default: Any = None) -> Any:
    """Retrieve a config value by key."""
    if not cls._loaded:
      cls.load()
    return cls.values.get(key, default)




  @staticmethod
  def _cast_env_value(env_val: str, default_val: Any) -> Any:
    """Cast environment variable string to the type of default_val."""
    if isinstance(default_val, bool):
      return env_val.lower() in ("true", "1", "yes")
    if isinstance(default_val, int):
      return int(env_val)
    if isinstance(default_val, float):
      return float(env_val)
    return env_val
