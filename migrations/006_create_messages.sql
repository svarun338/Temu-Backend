-- client_id is a client-generated id used to make sends idempotent across reconnects/retries.
-- migrate:up
CREATE TABLE messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id       BIGINT UNSIGNED NOT NULL,
  client_id       VARCHAR(64)     NULL,
  body            TEXT            NOT NULL,
  delivered_at    DATETIME(3)     NULL,
  read_at         DATETIME(3)     NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_messages_sender_client_id (sender_id, client_id),
  KEY idx_messages_conversation_id (conversation_id, id),
  KEY idx_messages_unread (conversation_id, read_at, sender_id),
  KEY idx_messages_undelivered (conversation_id, delivered_at),
  CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE conversations
  ADD CONSTRAINT fk_conversations_last_message
  FOREIGN KEY (last_message_id) REFERENCES messages (id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE conversations DROP FOREIGN KEY fk_conversations_last_message;
DROP TABLE IF EXISTS messages;
