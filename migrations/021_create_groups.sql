-- migrate:up
ALTER TABLE conversations MODIFY COLUMN type ENUM('direct', 'group') NOT NULL DEFAULT 'direct';

-- Group details (one row per group conversation). "chat_groups" because GROUPS is a reserved word in MySQL 8.
CREATE TABLE chat_groups (
  conversation_id  BIGINT UNSIGNED NOT NULL,
  name             VARCHAR(80)     NOT NULL,
  description      VARCHAR(500)    NULL,
  avatar_path      VARCHAR(100)    NULL,
  invite_code      CHAR(22)        NULL,
  send_permission  ENUM('all', 'admins') NOT NULL DEFAULT 'all',
  edit_permission  ENUM('all', 'admins') NOT NULL DEFAULT 'admins',
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (conversation_id),
  UNIQUE KEY uq_chat_groups_invite_code (invite_code),
  CONSTRAINT fk_chat_groups_conversation FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_groups_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Group members are conversation participants with a role.
-- last_read/last_delivered are per-member receipt watermarks (used for groups).
ALTER TABLE conversation_participants
  ADD COLUMN role                      ENUM('owner', 'admin', 'member') NOT NULL DEFAULT 'member' AFTER user_id,
  ADD COLUMN added_by                  BIGINT UNSIGNED NULL AFTER role,
  ADD COLUMN last_read_message_id      BIGINT UNSIGNED NULL AFTER joined_at,
  ADD COLUMN last_delivered_message_id BIGINT UNSIGNED NULL AFTER last_read_message_id,
  ADD CONSTRAINT fk_participants_added_by FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE SET NULL;

-- System messages ("Alice added Bob", "Group renamed", …): event_type set, body empty.
ALTER TABLE messages
  ADD COLUMN event_type VARCHAR(32) NULL AFTER body,
  ADD COLUMN event_data JSON NULL AFTER event_type;

-- migrate:down
ALTER TABLE messages DROP COLUMN event_data, DROP COLUMN event_type;
ALTER TABLE conversation_participants
  DROP FOREIGN KEY fk_participants_added_by,
  DROP COLUMN last_delivered_message_id,
  DROP COLUMN last_read_message_id,
  DROP COLUMN added_by,
  DROP COLUMN role;
DROP TABLE chat_groups;
DELETE FROM conversations WHERE type = 'group';
ALTER TABLE conversations MODIFY COLUMN type ENUM('direct') NOT NULL DEFAULT 'direct';
