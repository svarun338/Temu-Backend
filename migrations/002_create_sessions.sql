-- Refresh-token sessions. Only SHA-256 hashes of refresh tokens are stored.
-- migrate:up
CREATE TABLE sessions (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id             BIGINT UNSIGNED NOT NULL,
  token_hash          CHAR(64)        NOT NULL,
  previous_token_hash CHAR(64)        NULL,
  rotated_at          DATETIME(3)     NULL,
  user_agent          VARCHAR(255)    NULL,
  ip_address          VARCHAR(45)     NULL,
  expires_at          DATETIME(3)     NOT NULL,
  revoked_at          DATETIME(3)     NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  KEY idx_sessions_previous_token_hash (previous_token_hash),
  KEY idx_sessions_user (user_id, revoked_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE IF EXISTS sessions;
