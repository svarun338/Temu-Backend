-- migrate:up
-- End-to-end encryption. Every browser/device has its own key pair; only the
-- public key is stored here. The private key never leaves the device.
CREATE TABLE user_devices (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  public_key    VARCHAR(120)    NOT NULL,  -- base64 of the raw P-256 public key (65 bytes)
  fingerprint   CHAR(64)        NOT NULL,  -- SHA-256 of the public key (hex)
  name          VARCHAR(100)    NOT NULL,
  last_seen_at  DATETIME(3)     NULL,
  revoked_at    DATETIME(3)     NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_devices_key (user_id, fingerprint),
  KEY idx_user_devices_active (user_id, revoked_at),
  CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An encrypted message keeps its content only as ciphertext (body stays empty).
ALTER TABLE messages
  ADD COLUMN encrypted        TINYINT(1)      NOT NULL DEFAULT 0 AFTER sticker,
  ADD COLUMN ciphertext       MEDIUMTEXT      NULL AFTER encrypted,
  ADD COLUMN cipher_iv        VARCHAR(24)     NULL AFTER ciphertext,
  ADD COLUMN sender_device_id BIGINT UNSIGNED NULL AFTER cipher_iv,
  ADD CONSTRAINT fk_messages_sender_device FOREIGN KEY (sender_device_id) REFERENCES user_devices (id) ON DELETE SET NULL;

-- The message key, wrapped separately for every device allowed to read the message.
CREATE TABLE message_keys (
  message_id  BIGINT UNSIGNED NOT NULL,
  device_id   BIGINT UNSIGNED NOT NULL,
  wrapped     VARCHAR(100)    NOT NULL,
  salt        VARCHAR(32)     NOT NULL,
  iv          VARCHAR(24)     NOT NULL,
  PRIMARY KEY (message_id, device_id),
  KEY idx_message_keys_device (device_id),
  CONSTRAINT fk_message_keys_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_message_keys_device FOREIGN KEY (device_id) REFERENCES user_devices (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Encrypted files are opaque to the server (no type detection, no preview data).
ALTER TABLE attachments
  ADD COLUMN encrypted TINYINT(1) NOT NULL DEFAULT 0 AFTER page_count;

-- An encrypted live location keeps its latest position only as ciphertext.
ALTER TABLE message_locations
  MODIFY COLUMN latitude  DECIMAL(9, 6) NULL,
  MODIFY COLUMN longitude DECIMAL(9, 6) NULL,
  ADD COLUMN cipher     TEXT        NULL AFTER accuracy_m,
  ADD COLUMN cipher_iv  VARCHAR(24) NULL AFTER cipher;

-- migrate:down
DELETE FROM message_locations WHERE latitude IS NULL OR longitude IS NULL;
ALTER TABLE message_locations
  DROP COLUMN cipher_iv,
  DROP COLUMN cipher,
  MODIFY COLUMN latitude  DECIMAL(9, 6) NOT NULL,
  MODIFY COLUMN longitude DECIMAL(9, 6) NOT NULL;
ALTER TABLE attachments DROP COLUMN encrypted;
DROP TABLE message_keys;
ALTER TABLE messages
  DROP FOREIGN KEY fk_messages_sender_device,
  DROP COLUMN sender_device_id,
  DROP COLUMN cipher_iv,
  DROP COLUMN ciphertext,
  DROP COLUMN encrypted;
DROP TABLE user_devices;
