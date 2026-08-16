import logging
import sqlite3

from pathlib import Path
from typing import Any, Optional

from rxonly.config import Config


# The oldest schema this code can read, not the newest it has seen.
#
# mesh-collector owns the schema and writes the version into meta; readers
# upgrade independently. This value only changes when a query starts depending
# on something introduced by a newer schema version. See mesh-collector's
# schema.sql for the versioning rules.
#
# 0.10.0 because the message and DM routes select `emoji`, added in 0.10.0. It
# was 0.9.0 for routes/api/nodes.py selecting hops_away, and 0.8.0 for the
# telemetry columns before that.
#
# Note that 0.10.0 is *newer* than 0.9.0 — the comparison below splits on '.'
# and compares integers precisely so this reads correctly. A lexical compare
# would put this archive below the one it supersedes.
REQUIRED_SCHEMA = "0.10.0"




# "The mesh has told us a name for this node", and the one place it is written.
#
# Names and nothing else. A node can report a hardware model and no name at all, so
# testing `hardware` would keep rows this is meant to hide; and a `long_name` of
# 'Meshtastic 18b7' is a real name that unconfigured firmware genuinely announces,
# not a fabricated one. Unnamed is `long_name IS NULL AND short_name IS NULL`, and
# this is its negation. mesh-console spells the same predicate the same way in its
# db/queries.py — a deliberate reimplementation, as both readers' node queries are.
_NAMED_NODE = "(long_name IS NOT NULL OR short_name IS NOT NULL)"




def node_where(*conditions: str) -> str:
  """A WHERE clause for a node *list*, honouring LIST_UNNAMED_NODES.

  Returns "" only when there is nothing at all to restrict — no caller condition
  and the reader has asked to see unnamed nodes.

  Every discovery surface builds its clause here so the count cannot disagree with
  the list it counts: `/api/nodes` totals its own page, the dashboard totals the
  first page it renders, and `/api/stats` totals the sidebar. A filtered list
  beside an unfiltered total is the bug this exists to make hard to write.

  Conditions are ANDed, so a caller passing an OR chain must parenthesise it — the
  search clause in routes/api/nodes.py does. **This is for lists only.** Resolving a
  node by the id it is addressed by ignores the flag entirely and so must not call
  this: see `WEB_CONFIG` in rxonly/config.py for why that distinction is the point.
  """
  clauses = [condition for condition in conditions if condition]

  if not Config.get("LIST_UNNAMED_NODES", False):
    clauses.append(_NAMED_NODE)

  if not clauses:
    return ""

  return "WHERE " + " AND ".join(clauses)


def drawn_rows(table: str, alias: str) -> str:
  """A condition for "this row becomes a list item", as the message list decides it.

  The counterpart of `node_where` for messages, and here for the same reason: so a
  count cannot disagree with the list it counts. The list does not draw one row per
  archived row — `partition_tapbacks` in messages.js pulls out every tapback that
  has a parent in the archive and renders it as a pill on that parent, so it never
  becomes an `li[data-message-id]`.

  **A row that is never an `li` can never be scrolled past.** `update_read_position`
  reads the reader's position off `li` elements and nothing else, so a folded row
  counted as the newest thing in a channel sets a mark the reader cannot reach. That
  was live: Primary's newest inbound row was a '👋' reaction and the newest drawn row
  was 85 minutes older, so the channel stayed bold however often it was read.

  **`emoji IS 1` only, mirroring is_tapback's first branch.** Rows written before
  schema 0.10.0 carry `emoji IS NULL`, and for those the client falls back to an
  emoji-only text heuristic — `is_emoji_only`, which uses Intl.Segmenter and has no
  SQL equivalent. So one legacy reaction can still hold a channel bold. That set is
  bounded and never added to, and `get_unread_ceiling` in rxonly.js is the backstop
  that clears it the moment the reader reaches the end of the list.

  **`IS 1` and not `= 1`, which this said until mesh-console's copy of the rule was
  written and the difference showed up under test.** `NULL = 1` is NULL, so
  `NOT (TRUE AND NULL AND TRUE)` is NULL, and a NULL in a WHERE or an ON is not true.
  Spelled `= 1` this condition dropped every pre-0.10.0 reply whose parent is still
  archived — not only the legacy reactions the paragraph above is about, but ordinary
  legacy replies, which are rows the list plainly draws. Measured against the live
  archive when it was fixed: 211 rows held, 125 counted by `= 1` and 144 by `IS 1`,
  so 19 drawn rows were missing from every channel count and from the newest-drawn
  rx_time the unread cue compares against. (The archive holds 23 legacy replies; the
  other four have no parent left and were counted either way, being orphans.) `IS` is
  SQLite's null-safe comparison, and it gives NULL the answer the fallback above
  assumes it already had.

  The orphan half of the client's rule is expressible exactly: `reply_to_text` comes
  from a LEFT JOIN against the whole table, so "no parent in the archive" is this
  EXISTS going false — and such a tapback *is* drawn, as an ordinary row.

  **This rule is maintained by hand in three languages**, here, in `is_tapback` /
  `is_orphan_tapback` in messages.js, and in `_drawn_rows` in mesh-console's
  db/queries.py — which is the same SQL against the same two tables, arrived at
  from that reader's own `is_tapback` in ui/tapbacks.py. Change one, change the
  others.

  Returns a bare condition, not a clause, because its callers need it in three
  positions: a WHERE, an AND onto an existing WHERE, and a LEFT JOIN's ON.

  `table` and `alias` are literals from the call sites and never arrive from a
  request, so interpolating them is not an injection vector.
  """
  return f"""
    NOT (
      {alias}.reply_to IS NOT NULL
      AND {alias}.emoji IS 1
      AND EXISTS (SELECT 1 FROM {table} p WHERE p.message_id = {alias}.reply_to)
    )
  """


def cursor_clause(
  cur: sqlite3.Cursor,
  table: str,
  alias: str,
  *,
  direction: str,
  rx_time: int,
  row_id: Optional[int] = None,
  scope: str = "",
  scope_params: tuple[Any, ...] = (),
) -> tuple[str, list[Any]]:
  """"Everything older/newer than this row", as a condition and its parameters.

  **A cursor is an `(rx_time, id)` pair, not a timestamp.** rx_time is whole seconds
  off the mesh, so two messages in one channel routinely share one. A bare
  `rx_time < cursor` drops *every* row in the boundary second, including ones the
  previous page never showed — and the next page-back asks for something older still,
  so those rows are skipped once and skipped permanently. The fixture archive carries
  the shape: two messages at the same second in channel 0, one of them the parent of a
  later tapback, so losing it also stranded a reaction with nothing to attach to.

  Every predicate on either side of a page boundary is built here, which is the point.
  The page query and the two has_more probes beside it used to be written out
  separately, the probes comparing the pair and the page comparing the timestamp, and
  the server would correctly report that older rows existed and then decline to serve
  them. One spelling cannot disagree with itself.

  **`row_id` is optional because the bare form has to keep working.** Bookmarks and
  hand-written callers carry `?before_rx_time=` alone, and the client did too before it
  learned to send the id. Given only a second, the boundary row is resolved against the
  archive as the newest row in that second when paging back and the oldest when paging
  forward — which is the row a caller that had just been served a page must have
  stopped on, and which makes the bare form lossless rather than merely unchanged.

  The residual, since a bare cursor cannot name a row: a caller paging with one through
  a run of *three or more* messages in a single second, with a page smaller than the
  run, is handed the same window again rather than advancing. Sending `before_id` is
  what makes progress, and every caller in this project now does. That is a stall a
  reader can see and retry past; the timestamp-only cursor it replaces lost rows
  silently.

  `scope` is the restriction the page itself is under — a channel, a conversation —
  and is read only when `row_id` is None, because a tie has to be resolved among the
  rows the caller can actually see. It and `table`/`alias` are literals from the call
  sites and never arrive from a request, so interpolating them is not an injection
  vector.
  """
  if direction not in ("before", "after"):
    raise ValueError(f"direction is 'before' or 'after', not {direction!r}")

  comparison = "<" if direction == "before" else ">"

  if row_id is None:
    edge = "MAX" if direction == "before" else "MIN"
    scope_filter = f" AND {scope}" if scope else ""
    cur.execute(
      f"""
      SELECT {edge}({alias}.id) AS id
      FROM {table} {alias}
      WHERE {alias}.rx_time = ?{scope_filter}
      """,
      [rx_time, *scope_params],
    )
    resolved = cur.fetchone()["id"]
    # Nothing carries that second — a cursor pointing between two of them, or past
    # the end. The tie half of the condition then matches nothing whatever id goes
    # in it, and the whole reduces to the plain inequality.
    row_id = resolved if resolved is not None else 0

  condition = (
    f"({alias}.rx_time {comparison} ? "
    f"OR ({alias}.rx_time = ? AND {alias}.id {comparison} ?))"
  )
  return condition, [rx_time, rx_time, row_id]


def channel_message_counts(cur: sqlite3.Cursor) -> list[dict[str, Any]]:
  """Every channel, with the number of rows its message list will actually draw.

  `node_where` and `drawn_rows` exist so that a count and the list it counts cannot
  disagree; this exists so that two *callers* of them cannot. The dashboard renders
  the sidebar and `/api/stats` rewrites it ten seconds later, and they were running
  this query twice — near-identically, three files apart, with comments on each
  telling the reader to keep them in step. The dashboard's version carried `c.name`
  and an ORDER BY that stats did not need; that is the whole of the difference, and
  a column already on the join is cheaper than a second query to maintain.

  Ordered by channel_index, and every channel is present even when nothing in it
  is drawn — the predicate is on the LEFT JOIN rather than in a WHERE, so a channel
  whose rows are all folded reactions reports 0 instead of dropping out and leaving
  the client to fall back on `|| 0`.
  """
  cur.execute(
    f"""
    SELECT c.channel_index, c.name, COUNT(m.id) AS message_count
    FROM channels c
    LEFT JOIN messages m
      ON c.channel_index = m.channel_index
     AND {drawn_rows("messages", "m")}
    GROUP BY c.channel_index, c.name
    ORDER BY c.channel_index
    """
  )
  return [dict(row) for row in cur.fetchall()]


def direct_message_counts(cur: sqlite3.Cursor) -> tuple[int, int]:
  """`(held, drawn)` — how many direct messages the archive has, and how many list.

  Two numbers because the dashboard and the sidebar are asking two questions. The
  first is an archive figure and belongs beside `total_messages`, which is what
  matters when thinking about MAX_DIRECT_MESSAGES pruning. The second is what the
  DM list will draw, which is what belongs next to a name in the sidebar and is the
  number that gets bolded. They differ by the folded reactions, and each is right
  where it is.

  Extracted for the same reason `channel_message_counts` above was: the caller that
  renders the sidebar and the caller that refreshes it were carrying identical
  copies of both queries and identical comments explaining why they had to match.

  **The caller decides whether to ask at all.** Whether direct messages are exposed
  is a decision about this process rather than about the archive, so this does not
  read SERVE_DIRECT_MESSAGES — a helper that silently returned zeroes would make
  "off" and "none" indistinguishable at the call site.
  """
  cur.execute("SELECT COUNT(*) AS count FROM direct_messages")
  held: int = cur.fetchone()["count"]

  cur.execute(
    f"""
    SELECT COUNT(*) AS count
    FROM direct_messages d
    WHERE {drawn_rows("direct_messages", "d")}
    """
  )
  drawn: int = cur.fetchone()["count"]

  return held, drawn


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
