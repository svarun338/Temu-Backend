-- migrate:up
-- Recordings of voice/video calls, made in a participant's browser and uploaded in chunks
-- while the call goes on. status: recording → ready (stored) or failed.
-- The file lives in object storage (local disk or S3) under storage_key; storage_driver
-- says which, so files stay reachable after switching drivers.
CREATE TABLE call_recordings (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  call_id          BIGINT UNSIGNED NOT NULL,
  conversation_id  BIGINT UNSIGNED NOT NULL,
  recorder_id      BIGINT UNSIGNED NOT NULL,
  kind             ENUM('audio', 'video') NOT NULL,
  mime_type        VARCHAR(50)     NOT NULL,
  status           ENUM('recording', 'ready', 'failed') NOT NULL DEFAULT 'recording',
  storage_driver   ENUM('local', 's3') NULL,
  storage_key      VARCHAR(512)    NULL,
  next_seq         INT UNSIGNED    NOT NULL DEFAULT 0,
  size_bytes       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms      INT UNSIGNED    NULL,
  started_at       DATETIME(3)     NOT NULL,
  finished_at      DATETIME(3)     NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_call_recordings_call (call_id, id),
  KEY idx_call_recordings_conversation (conversation_id, id),
  KEY idx_call_recordings_recorder (recorder_id, id),
  KEY idx_call_recordings_status (status),
  CONSTRAINT fk_call_recordings_call FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE CASCADE,
  CONSTRAINT fk_call_recordings_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_call_recordings_recorder FOREIGN KEY (recorder_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE call_recordings;
