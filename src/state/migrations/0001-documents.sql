-- The fleet state as it was before it carried a schema version: the
-- documents and the head. A database without a version has exactly these.
CREATE TABLE IF NOT EXISTS documents (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS head (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  written_at TEXT NOT NULL
) STRICT;
