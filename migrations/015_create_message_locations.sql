-- migrate:up
-- A shared location attached to a message. Live locations are updated by the
-- sender until live_until (or until they stop sharing).
CREATE TABLE message_locations (
  message_id   BIGINT UNSIGNED NOT NULL,
  latitude     DECIMAL(9, 6)   NOT NULL,
  longitude    DECIMAL(9, 6)   NOT NULL,
  accuracy_m   INT UNSIGNED    NULL,
  is_live      TINYINT(1)      NOT NULL DEFAULT 0,
  live_until   DATETIME(3)     NULL,
  stopped_at   DATETIME(3)     NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (message_id),
  KEY idx_message_locations_live (is_live, live_until),
  CONSTRAINT fk_message_locations_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT chk_message_locations_lat CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT chk_message_locations_lng CHECK (longitude BETWEEN -180 AND 180)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE message_locations;
