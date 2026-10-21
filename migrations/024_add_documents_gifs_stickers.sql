-- migrate:up
-- Document preview: number of pages of a PDF (its first page is the thumbnail).
ALTER TABLE attachments
  ADD COLUMN page_count SMALLINT UNSIGNED NULL AFTER duration_ms,
  MODIFY COLUMN kind ENUM('image', 'video', 'audio', 'voice', 'file', 'sticker') NOT NULL;

-- A built-in sticker ("blob:love", "emoji:😂"); custom stickers are attachments of kind 'sticker'.
ALTER TABLE messages
  ADD COLUMN sticker VARCHAR(40) NULL AFTER body;

-- "My stickers": stickers I made from photos or saved from chats. The image is shared
-- storage (like a forwarded file), so saving or sending again never copies bytes.
CREATE TABLE user_stickers (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  storage_key  CHAR(32)        NOT NULL,
  mime_type    VARCHAR(100)    NOT NULL,
  size_bytes   INT UNSIGNED    NOT NULL,
  width        INT UNSIGNED    NULL,
  height       INT UNSIGNED    NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_stickers_key (user_id, storage_key),
  KEY idx_user_stickers_storage (storage_key),
  CONSTRAINT fk_user_stickers_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE user_stickers;
ALTER TABLE messages DROP COLUMN sticker;
ALTER TABLE attachments
  DROP COLUMN page_count,
  MODIFY COLUMN kind ENUM('image', 'video', 'audio', 'voice', 'file') NOT NULL;
