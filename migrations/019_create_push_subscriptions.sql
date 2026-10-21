-- migrate:up
-- Web Push endpoints (one per browser/device), tied to the login session that
-- created them so logging out stops notifications on that device.
CREATE TABLE push_subscriptions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  session_id     BIGINT UNSIGNED NOT NULL,
  endpoint       VARCHAR(1024)   NOT NULL,
  endpoint_hash  CHAR(64)        NOT NULL,
  p256dh         VARCHAR(255)    NOT NULL,
  auth           VARCHAR(255)    NOT NULL,
  user_agent     VARCHAR(255)    NULL,
  last_used_at   DATETIME(3)     NULL,
  created_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_push_subscriptions_endpoint (endpoint_hash),
  KEY idx_push_subscriptions_user (user_id),
  KEY idx_push_subscriptions_session (session_id),
  CONSTRAINT fk_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_push_subscriptions_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE push_subscriptions;
