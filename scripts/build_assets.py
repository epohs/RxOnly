#!/usr/bin/env python3
"""
Build script for minified frontend assets.

This script:
- Minifies CSS and JavaScript sources under rxonly/web/static
- Generates content-hashed filenames (rxonly-<HASH>.min.{css,js})
- Stores the active asset paths in the application meta table
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
from rxonly.db import Storage


STATIC_DIR = Path(__file__).resolve().parent.parent / "rxonly" / "web" / "static"
CSS_DIR = STATIC_DIR / "css"
JS_DIR = STATIC_DIR / "js"

CSS_SOURCE = CSS_DIR / "rxonly.css"
JS_SOURCES = [
  JS_DIR / "rxonly.js",
  JS_DIR / "messages.js",
  JS_DIR / "nodes.js",
  JS_DIR / "views.js",
]

CSS_META_KEY = "css_filename"
JS_META_KEY = "js_filename"

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




def build_css(storage: Storage) -> str:
  """Minify CSS source and store the hashed filename in meta."""
  source = CSS_SOURCE.read_text(encoding="utf-8")
  minified = rcssmin.cssmin(source)

  hashed = content_hash(minified)
  filename = f"rxonly-{hashed}.min.css"
  out_path = CSS_DIR / filename

  out_path.write_text(minified, encoding="utf-8")
  storage.set_meta(CSS_META_KEY, f"css/{filename}")
  cleanup_old(CSS_DIR, "rxonly-", ".min.css", filename)

  logging.info("Built %s", filename)
  return filename




def build_js(storage: Storage) -> str:
  """Concatenate JS sources in load order, minify, and store the hashed filename in meta."""
  parts = []
  for src in JS_SOURCES:
    parts.append(src.read_text(encoding="utf-8"))

  combined = "\n".join(parts)
  minified = rjsmin.jsmin(combined)

  hashed = content_hash(minified)
  filename = f"rxonly-{hashed}.min.js"
  out_path = JS_DIR / filename

  out_path.write_text(minified, encoding="utf-8")
  storage.set_meta(JS_META_KEY, f"js/{filename}")
  cleanup_old(JS_DIR, "rxonly-", ".min.js", filename)

  logging.info("Built %s", filename)
  return filename




def main() -> None:
  Config.load()

  log_level = logging.DEBUG if Config.get("DEBUG", False) else logging.INFO
  logging.basicConfig(level=log_level, format=LOG_FORMAT)

  storage = Storage()

  try:
    build_css(storage)
    build_js(storage)
  finally:
    storage.close()

  logging.info("Asset build complete")




if __name__ == "__main__":
  main()

