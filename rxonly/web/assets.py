"""The built-asset manifest — the contract between the build script and the app.

`scripts/build_assets.py` writes it; the dashboard reads it. It lives in a file
rather than the archive's `meta` table because which stylesheet this app built
for itself is not a fact about the mesh, and a CSS minifier has no business
opening the archive to record one. That separation is what lets this project
carry no schema and no write layer at all.

The manifest is a build product, committed alongside the hashed files it names,
so a fresh checkout serves minified assets without running the build first.
"""

from __future__ import annotations

import json
import logging
import re

from pathlib import Path
from typing import Optional


STATIC_DIR = Path(__file__).resolve().parent / "static"
MANIFEST_PATH = STATIC_DIR / "asset-manifest.json"

CSS_KEY = "css"
JS_KEY = "js"

# What a built filename looks like, and the reason one can be cached forever.
#
# `build_assets.py` names its output `rxonly-<hash>.min.css` / `.js`, where the hash
# is the first eight uppercase hex characters of the minified content's SHA-256. So
# the name *is* the content: change a byte of CSS and the URL changes with it, and a
# browser holding the old one is holding something that is still correct for the page
# that asked for it. That is what makes a year-long `immutable` honest here and a lie
# for `rxonly.css`, whose name says nothing about what is inside it.
#
# Kept in this module rather than beside the cache header that uses it, because the
# shape being matched is the one `build_assets.py` writes — this file is already the
# contract between the two, and a pattern that drifts from `content_hash()` would
# silently stop recognising a build product rather than fail.
HASHED_ASSET = re.compile(r"/rxonly-[0-9A-F]{8}\.min\.(?:css|js)$")


def is_hashed_asset(path: str) -> bool:
  """Whether `path` names a build product whose filename encodes its own content."""
  return HASHED_ASSET.search(path) is not None


_cache: Optional[dict[str, str]] = None




def write_manifest(css_filename: str, js_filename: str) -> None:
  """Record the current build's asset paths, relative to the static directory."""
  MANIFEST_PATH.write_text(
    json.dumps(
      {CSS_KEY: f"css/{css_filename}", JS_KEY: f"js/{js_filename}"},
      indent=2,
    ) + "\n",
    encoding="utf-8",
  )




def read_manifest() -> dict[str, str]:
  """Return the built-asset paths, or an empty mapping if there is no build.

  Cached once read, since the filenames are content-hashed and only change when
  the build script runs. An absent or unreadable manifest is not cached: the
  templates fall back to unminified sources, and a build that happens while a
  development server is running is then picked up without a restart.
  """
  global _cache

  if _cache is not None:
    return _cache

  try:
    values = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
  except FileNotFoundError:
    return {}
  except (OSError, ValueError) as e:
    logging.warning("Could not read %s: %s", MANIFEST_PATH, e)
    return {}

  if not isinstance(values, dict):
    logging.warning("%s is not a JSON object; ignoring it", MANIFEST_PATH)
    return {}

  _cache = {
    key: value for key, value in values.items()
    if key in (CSS_KEY, JS_KEY) and isinstance(value, str)
  }

  return _cache
