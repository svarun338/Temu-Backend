-- migrate:up
ALTER TABLE users
  ADD COLUMN email_verified_at DATETIME(3)  NULL AFTER password_hash,
  ADD COLUMN about             VARCHAR(140) NULL AFTER email_verified_at,
  ADD COLUMN status            ENUM('available', 'busy', 'away', 'dnd') NOT NULL DEFAULT 'available' AFTER about,
  ADD COLUMN avatar_path       VARCHAR(100) NULL AFTER status;

-- Accounts created before email verification existed are treated as verified.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

-- migrate:down
ALTER TABLE users
  DROP COLUMN avatar_path,
  DROP COLUMN status,
  DROP COLUMN about,
  DROP COLUMN email_verified_at;
