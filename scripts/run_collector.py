#!/usr/bin/env python3
"""
Thin entry point for the RxOnly Meshtastic collector.

This script exists for:
  - systemd service execution
  - local development convenience

All real logic lives in rxonly/collector/__init__.py
"""

import sys
from pathlib import Path

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def main() -> None:
    from rxonly.collector import main as collector_main
    collector_main()


if __name__ == "__main__":
    main()
