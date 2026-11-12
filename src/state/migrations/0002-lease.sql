-- The manager lease: which machine may change the fleet state, and until
-- when. It travels with the state, so the bucket says who holds it.
CREATE TABLE IF NOT EXISTS lease (
  one INTEGER PRIMARY KEY CHECK (one = 1),
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
