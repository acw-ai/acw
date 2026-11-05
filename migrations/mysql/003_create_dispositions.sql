-- Dynamic call disposition catalog managed by supervisors
CREATE TABLE IF NOT EXISTS dispositions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  requires_follow_up TINYINT(1) NOT NULL DEFAULT 0,
  is_conversion TINYINT(1) NOT NULL DEFAULT 0,
  is_unanswered TINYINT(1) NOT NULL DEFAULT 0,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_disp_cat_name (category, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
