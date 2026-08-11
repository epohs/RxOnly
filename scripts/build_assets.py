#!/usr/bin/env python3
"""
Build script for minified frontend assets.

This script:
- Minifies CSS and JavaScript sources under rxonly/web/static
- Generates content-hashed filenames (rxonly-<HASH>.min.{css,js})
- Records the active asset paths in static/asset-manifest.json
- Removes previous hashed builds

Used during development to ensure cache busting and a single
authoritative asset version.
"""


from __future__ import annotations

import hashlib
import logging
import sys

from pathlib import Path

import rcssmin
import rjsmin

# Allow imports from the project root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rxonly.config import Config
from rxonly.web.assets import MANIFEST_PATH, STATIC_DIR, write_manifest


CSS_DIR = STATIC_DIR / "css"
JS_DIR = STATIC_DIR / "js"

CSS_SOURCE = CSS_DIR / "rxonly.css"
JS_SOURCES = [
  JS_DIR / "rxonly.js",
  JS_DIR / "messages.js",
  JS_DIR / "nodes.js",
  JS_DIR / "views.js",
]

LOG_FORMAT = "[%(levelname)s] %(message)s"




def content_hash(data: str) -> str:
  """Return a short uppercase hash of the given string content."""
  return hashlib.sha256(data.encode("utf-8")).hexdigest()[:8].upper()




def cleanup_old(directory: Path, prefix: str, suffix: str, keep: str) -> None:
  """Remove previous minified files, keeping only the current build."""
  for f in directory.iterdir():
    if f.name == keep:
      continue
    if f.name.startswith(prefix) and f.name.endswith(suffix):
      f.unlink()
      logging.info("Removed old asset: %s", f.name)




def build_css() -> str:
  """Minify CSS source and return the hashed filename."""
  source = CSS_SOURCE.read_text(encoding="utf-8")
  minified = rcssmin.cssmin(source)

  hashed = content_hash(minified)
  filename = f"rxonly-{hashed}.min.css"
  out_path = CSS_DIR / filename

  out_path.write_text(minified, encoding="utf-8")
  cleanup_old(CSS_DIR, "rxonly-", ".min.css", filename)

  logging.info("Built %s", filename)
  return filename




def build_js() -> str:
  """Concatenate JS sources in load order, minify, and return the hashed filename."""
  parts = []
  for src in JS_SOURCES:
    parts.append(src.read_text(encoding="utf-8"))

  combined = "\n".join(parts)
  minified = rjsmin.jsmin(combined)

  hashed = content_hash(minified)
  filename = f"rxonly-{hashed}.min.js"
  out_path = JS_DIR / filename

  out_path.write_text(minified, encoding="utf-8")
  cleanup_old(JS_DIR, "rxonly-", ".min.js", filename)

  logging.info("Built %s", filename)
  return filename




def main() -> None:
  # Web tooling, so it reads the web app's environment. It records what it built
  # in a manifest file rather than the archive, so this script needs no database
  # and no write layer — see rxonly/web/assets.py.
  Config.load()

  log_level = logging.DEBUG if Config.get("DEBUG", False) else logging.INFO
  logging.basicConfig(level=log_level, format=LOG_FORMAT)

  write_manifest(build_css(), build_js())

  logging.info("Wrote %s", MANIFEST_PATH.name)
  logging.info("Asset build complete")
  logging.info("Restart the web service to pick up the new manifest: sudo systemctl restart rxonly-www")




if __name__ == "__main__":
  main()
