-- GETUS dispositions: initial schema (MySQL 8 / MariaDB 10.6+)
-- Times are stored in UTC.

CREATE TABLE IF NOT EXISTS calls (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  call_key         VARCHAR(120)    NOT NULL,
  pbx_call_id      VARCHAR(40)     NULL,
  participant_id   VARCHAR(40)     NULL,
  extension        VARCHAR(16)     NOT NULL,
  agent_name       VARCHAR(120)    NULL,
  customer_number  VARCHAR(64)     NULL,
  customer_name    VARCHAR(160)    NULL,
  direction        ENUM('inbound','outbound','unknown') NOT NULL DEFAULT 'unknown',
  status           ENUM('active','pending','completed','not_required','waived') NOT NULL DEFAULT 'active',
  started_at       DATETIME(3)     NOT NULL,
  answered_at      DATETIME(3)     NULL,
  ended_at         DATETIME(3)     NULL,
  talk_seconds     INT UNSIGNED    NULL,
  category         VARCHAR(80)     NULL,
  disposition      VARCHAR(120)    NULL,
  sub_disposition  VARCHAR(200)    NULL,
  notes            TEXT            NULL,
  follow_up_date   DATE            NULL,
  disposed_at      DATETIME(3)     NULL,
  waived_by        VARCHAR(80)     NULL,
  waived_reason    VARCHAR(300)    NULL,
  UNIQUE KEY uq_calls_call_key (call_key),
  KEY idx_calls_ext_status (extension, status),
  KEY idx_calls_started (started_at),
  KEY idx_calls_disposition (disposition)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agents (
  extension   VARCHAR(16)  NOT NULL PRIMARY KEY,
  name        VARCHAR(120) NULL,
  held        TINYINT(1)   NOT NULL DEFAULT 0,
  held_since  DATETIME(3)  NULL,
  last_seen   DATETIME(3)  NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
