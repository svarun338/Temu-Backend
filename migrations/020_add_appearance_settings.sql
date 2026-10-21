-- migrate:up
-- Appearance preferences. Wallpapers are "preset:<name>" or "custom:<user_wallpapers.id>".
ALTER TABLE user_settings
  ADD COLUMN theme             ENUM('system', 'light', 'dark') NOT NULL DEFAULT 'system' AFTER sound_enabled,
  ADD COLUMN accent            ENUM('indigo', 'emerald', 'rose', 'amber', 'sky', 'violet', 'teal') NOT NULL DEFAULT 'indigo' AFTER theme,
  ADD COLUMN font_size         ENUM('small', 'medium', 'large') NOT NULL DEFAULT 'medium' AFTER accent,
  ADD COLUMN bubble_style      ENUM('rounded', 'soft', 'square') NOT NULL DEFAULT 'rounded' AFTER font_size,
  ADD COLUMN default_wallpaper VARCHAR(40) NULL AFTER bubble_style;

-- A per-chat wallpaper overrides the default one.
ALTER TABLE chat_settings
  ADD COLUMN wallpaper VARCHAR(40) NULL AFTER muted_until;

-- Wallpaper images a user uploaded (private to them; files have random names).
CREATE TABLE user_wallpapers (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  file_name   VARCHAR(64)     NOT NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_wallpapers_file (file_name),
  KEY idx_user_wallpapers_user (user_id, id),
  CONSTRAINT fk_user_wallpapers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE user_wallpapers;
ALTER TABLE chat_settings DROP COLUMN wallpaper;
ALTER TABLE user_settings
  DROP COLUMN default_wallpaper,
  DROP COLUMN bubble_style,
  DROP COLUMN font_size,
  DROP COLUMN accent,
  DROP COLUMN theme;
