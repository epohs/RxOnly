import sqlite3

from rxonly.config import Config



def get_db_connection() -> sqlite3.Connection:
  db_path: str = Config.get("DB_PATH")
  uri: str = f"file:{db_path}?mode=ro"

  conn = sqlite3.connect(
    uri,
    uri=True,
    timeout=2.5,
  )
  
  conn.row_factory = sqlite3.Row
  conn.execute("PRAGMA query_only = ON;")
  conn.execute("PRAGMA busy_timeout = 2500;")

  return conn
