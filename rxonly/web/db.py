import logging
import sqlite3

from pathlib import Path
from typing import Optional

from rxonly.config import Config


# The oldest schema this code can read, not the newest it has seen.
#
# mesh-collector owns the schema and writes the version into meta; the two
# projects upgrade independently, so a reader has to say out loud what it needs.
# The rule the version number follows is documented in mesh-collector's
# schema.sql, which is the authority: a MAJOR bump breaks readers, a MINOR bump
# only adds. So the check below accepts any archive with the same major and a
# version at least this high, and this constant moves only when a query here
# starts depending on something newer.
#
# 0.8.0, because routes/api/nodes.py and routes/dashboard.py select the six
# telemetry columns 0.8.0 added. This sat at 0.6.0 for a long time and for a good
# reason: 0.7.0 added direct_messages.to_node, nothing here selected it, and a
# reader that has not started reading a column has no business refusing archives
# written before it. Reading telemetry is what ended that — the query cannot run
# against a 0.7.0 archive, so the constant has to say so.
#
# Still not imported from mesh-console, which moved to 0.8.0 in the same session
# for its own reasons. The two constants agreeing today is a coincidence of what
# each reader happens to select, not the two being kept in step.
REQUIRED_SCHEMA = "0.8.0"




class SchemaVersionMismatch(RuntimeError):
  """Raised when the archive's schema isn't one this code can read."""




def _parse_version(version: str) -> Optional[tuple[int, int, int]]:
  """Split 'MAJOR.MINOR.PATCH' into comparable parts, or None if it isn't one."""
  parts = version.strip().split(".")
  if len(parts) != 3:
    return None
  try:
    return (int(parts[0]), int(parts[1]), int(parts[2]))
  except ValueError:
    return None




def is_compatible(archive_version: str, required: str = REQUIRED_SCHEMA) -> bool:
  """Whether an archive at `archive_version` is readable by code needing `required`.

  Same major, and no older than what is required. An unparseable version is not
  compatible with anything: a reader that cannot tell what it is looking at
  should not proceed to select columns from it.
  """
  found = _parse_version(archive_version)
  needed = _parse_version(required)

  if found is None or needed is None:
    return False

  return found[0] == needed[0] and found >= needed




class ArchiveNotConfigured(RuntimeError):
  """Raised when DB_PATH has not been set to anything.

  Distinct from the archive merely being absent, which this app tolerates: an
  archive that doesn't exist yet is the collector not having started, and startup
  order isn't this app's to control. An unset DB_PATH is nobody's deployment
  order — it is a question nothing can answer for us.
  """




def archive_path() -> Optional[Path]:
  """The configured archive as an absolute path, or None when DB_PATH is unset.

  `~` is expanded here because SQLite will not do it — a `DB_PATH` of
  `~/mesh-collector/data/db.sqlite` would otherwise be looked for in a directory
  literally named `~`. Relative paths resolve against the working directory once,
  so a gunicorn worker cannot end up reading a different file from the one the
  master was configured with.
  """
  raw = (Config.get("DB_PATH") or "").strip()
  if not raw:
    return None
  return Path(raw).expanduser().resolve()




def get_db_connection() -> sqlite3.Connection:
  path = archive_path()
  if path is None:
    raise ArchiveNotConfigured(
      "DB_PATH is not set, so there is no archive to serve. Point it at the "
      "database mesh-collector writes — see config-sample.json, or export "
      "RXONLY_DB_PATH."
    )

  # Built through as_uri() rather than by interpolation: a path containing '?'
  # or '#' would otherwise be parsed as a URI query or fragment and the open
  # would fail on a filename that is perfectly legal on disk.
  uri = f"{path.as_uri()}?mode=ro"

  conn = sqlite3.connect(
    uri,
    uri=True,
    timeout=2.5,
  )

  conn.row_factory = sqlite3.Row
  conn.execute("PRAGMA query_only = ON;")
  conn.execute("PRAGMA busy_timeout = 2500;")

  return conn



def get_meta(conn: sqlite3.Connection, key: str) -> Optional[str]:
  """Read a single meta value, or None if the collector hasn't published it."""
  row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
  return row["value"] if row else None



def get_meta_int(conn: sqlite3.Connection, key: str, fallback: int) -> int:
  """Read an integer meta value, falling back when it is absent or unparseable.

  The fallback is deliberately conservative: an unpublished limit means we don't
  know what the collector keeps, not that we may assume a generous one.
  """
  value = get_meta(conn, key)
  if value is None:
    return fallback
  try:
    return int(value)
  except ValueError:
    return fallback



def check_schema_version() -> None:
  """Verify the archive's schema at startup, before serving any request.

  An unreachable database is not an error here: the collector may not have
  created it yet, and this app has always failed per-request in that case, so
  refusing to start would newly couple startup to deployment order. A database
  that exists but carries a schema this code cannot read is a hard failure —
  better a clear message at startup than an OperationalError halfway through
  rendering a page.

  An unset DB_PATH is a third case and fails too: `ArchiveNotConfigured` is not a
  `sqlite3.Error`, so it travels straight through the warning below. "Not yet
  created" is worth waiting out; "never told where to look" is not.
  """
  try:
    conn = get_db_connection()
  except sqlite3.Error as e:
    logging.warning(
      "Could not open the archive at %s to check its schema version: %s",
      archive_path(), e,
    )
    return

  try:
    try:
      version = get_meta(conn, "schema_version")
    except sqlite3.Error as e:
      raise SchemaVersionMismatch(
        f"The database at {archive_path()} has no readable meta table "
        f"({e}). RxOnly reads an archive written by mesh-collector; point "
        f"DB_PATH at one."
      ) from e
  finally:
    conn.close()

  if version is None:
    raise SchemaVersionMismatch(
      f"The database at {archive_path()} does not record a "
      f"schema_version. RxOnly reads schema {REQUIRED_SCHEMA} or newer, written "
      f"by mesh-collector."
    )

  if not is_compatible(version):
    raise SchemaVersionMismatch(
      f"The database at {archive_path()} is schema {version}; RxOnly needs "
      f"{REQUIRED_SCHEMA} or a later {REQUIRED_SCHEMA.split('.')[0]}.x. "
      f"Upgrade whichever side is behind — mesh-collector writes the schema, "
      f"this project only reads it."
    )
