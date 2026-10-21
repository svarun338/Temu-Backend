-- migrate:up
ALTER TABLE messages
  ADD COLUMN reply_to_id  BIGINT UNSIGNED NULL AFTER body,
  ADD COLUMN forwarded    TINYINT(1)      NOT NULL DEFAULT 0 AFTER reply_to_id,
  ADD COLUMN edited_at    DATETIME(3)     NULL AFTER forwarded,
  ADD COLUMN deleted_at   DATETIME(3)     NULL AFTER edited_at,
  ADD KEY idx_messages_reply_to (reply_to_id),
  ADD CONSTRAINT fk_messages_reply_to FOREIGN KEY (reply_to_id) REFERENCES messages (id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE messages
  DROP FOREIGN KEY fk_messages_reply_to,
  DROP KEY idx_messages_reply_to,
  DROP COLUMN deleted_at,
  DROP COLUMN edited_at,
  DROP COLUMN forwarded,
  DROP COLUMN reply_to_id;
