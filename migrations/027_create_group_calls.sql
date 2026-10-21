-- migrate:up
-- Group calls: a call in a group chat has no single callee (callee_id NULL, is_group = 1).
-- call_participants lists everyone who was rung (invited_at) and when they joined/left;
-- someone rung who never joined missed the call.
ALTER TABLE calls
  MODIFY COLUMN callee_id BIGINT UNSIGNED NULL,
  ADD COLUMN is_group TINYINT(1) NOT NULL DEFAULT 0 AFTER type;

CREATE TABLE call_participants (
  call_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  invited_at  DATETIME(3)     NOT NULL,
  joined_at   DATETIME(3)     NULL,
  left_at     DATETIME(3)     NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (call_id, user_id),
  KEY idx_call_participants_user (user_id, call_id),
  CONSTRAINT fk_call_participants_call FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE CASCADE,
  CONSTRAINT fk_call_participants_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE call_participants;
DELETE FROM calls WHERE is_group = 1;
ALTER TABLE calls
  DROP COLUMN is_group,
  MODIFY COLUMN callee_id BIGINT UNSIGNED NOT NULL;
