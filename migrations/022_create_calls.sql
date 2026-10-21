-- migrate:up
-- One-to-one voice/video calls (WebRTC; media flows peer to peer, the server only signals).
-- status: ringing → ongoing → ended, or ringing → missed / rejected / busy, or failed.
CREATE TABLE calls (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id  BIGINT UNSIGNED NOT NULL,
  caller_id        BIGINT UNSIGNED NOT NULL,
  callee_id        BIGINT UNSIGNED NOT NULL,
  type             ENUM('voice', 'video') NOT NULL,
  status           ENUM('ringing', 'ongoing', 'ended', 'missed', 'rejected', 'busy', 'failed') NOT NULL DEFAULT 'ringing',
  answered_at      DATETIME(3)     NULL,
  ended_at         DATETIME(3)     NULL,
  ended_by         BIGINT UNSIGNED NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_calls_caller (caller_id, id),
  KEY idx_calls_callee (callee_id, id),
  KEY idx_calls_conversation (conversation_id, id),
  KEY idx_calls_status (status),
  CONSTRAINT chk_calls_not_self CHECK (caller_id <> callee_id),
  CONSTRAINT fk_calls_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_calls_caller FOREIGN KEY (caller_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_calls_callee FOREIGN KEY (callee_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hiding a call from my history doesn't hide it for the other person.
CREATE TABLE call_hidden (
  call_id     BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (call_id, user_id),
  KEY idx_call_hidden_user (user_id),
  CONSTRAINT fk_call_hidden_call FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE CASCADE,
  CONSTRAINT fk_call_hidden_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE call_hidden;
DROP TABLE calls;
