-- direct_key = "<smallerUserId>:<largerUserId>" guarantees one direct conversation per user pair.
-- migrate:up
CREATE TABLE conversations (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type            ENUM('direct')  NOT NULL DEFAULT 'direct',
  direct_key      VARCHAR(64)     NULL,
  created_by      BIGINT UNSIGNED NULL,
  last_message_id BIGINT UNSIGNED NULL,
  last_message_at DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_conversations_direct_key (direct_key),
  KEY idx_conversations_last_message_at (last_message_at),
  CONSTRAINT fk_conversations_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE IF EXISTS conversations;
