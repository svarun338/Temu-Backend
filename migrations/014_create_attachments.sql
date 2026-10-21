-- migrate:up
-- Files attached to messages. A row is created when the upload finishes (message_id NULL)
-- and linked when the message is sent. Unlinked rows older than a day are cleaned up.
-- Several rows may share one stored file (forwarding); the file is deleted with its last row.
CREATE TABLE attachments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uploader_id      BIGINT UNSIGNED NOT NULL,
  conversation_id  BIGINT UNSIGNED NOT NULL,
  message_id       BIGINT UNSIGNED NULL,
  kind             ENUM('image', 'video', 'audio', 'voice', 'file') NOT NULL,
  mime_type        VARCHAR(100)    NOT NULL,
  original_name    VARCHAR(255)    NOT NULL,
  size_bytes       BIGINT UNSIGNED NOT NULL,
  storage_key      CHAR(32)        NOT NULL,
  thumbnail_key    CHAR(32)        NULL,
  width            INT UNSIGNED    NULL,
  height           INT UNSIGNED    NULL,
  duration_ms      INT UNSIGNED    NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_attachments_message (message_id, id),
  KEY idx_attachments_gallery (conversation_id, kind, id),
  KEY idx_attachments_orphans (message_id, created_at),
  KEY idx_attachments_storage (storage_key),
  KEY idx_attachments_thumbnail (thumbnail_key),
  CONSTRAINT fk_attachments_uploader FOREIGN KEY (uploader_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_attachments_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE attachments;
