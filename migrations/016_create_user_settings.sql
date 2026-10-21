-- migrate:up
-- Per-user preferences. A missing row means "all defaults".
CREATE TABLE user_settings (
  user_id                BIGINT UNSIGNED NOT NULL,
  notifications_enabled  TINYINT(1)      NOT NULL DEFAULT 1,
  message_preview        TINYINT(1)      NOT NULL DEFAULT 1,
  sound_enabled          TINYINT(1)      NOT NULL DEFAULT 1,
  created_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE user_settings;
