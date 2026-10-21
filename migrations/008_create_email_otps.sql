-- migrate:up
-- One-time codes for email verification and password reset.
-- Only an HMAC of the code is stored, so a database leak does not reveal live codes.
CREATE TABLE email_otps (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  purpose      ENUM('verify_email', 'reset_password') NOT NULL,
  code_hash    CHAR(64)        NOT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at   DATETIME(3)     NOT NULL,
  consumed_at  DATETIME(3)     NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_email_otps_lookup (user_id, purpose, consumed_at, created_at),
  KEY idx_email_otps_expires (expires_at),
  CONSTRAINT fk_email_otps_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE email_otps;
