-- Per-agent PIN sign-in. pin_set_at changes whenever a PIN is set, which signs the agent out everywhere.
ALTER TABLE agents
  ADD COLUMN pin_hash   VARCHAR(200) NULL,
  ADD COLUMN pin_set_at DATETIME(3)  NULL;
