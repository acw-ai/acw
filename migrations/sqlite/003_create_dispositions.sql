-- Dynamic call disposition catalog managed by supervisors
CREATE TABLE IF NOT EXISTS dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  requires_follow_up INTEGER NOT NULL DEFAULT 0,
  is_conversion INTEGER NOT NULL DEFAULT 0,
  is_unanswered INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (category, name)
);
