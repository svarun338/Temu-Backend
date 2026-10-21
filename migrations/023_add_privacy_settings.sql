-- migrate:up
-- Who may see my "online" and "last seen":
--   everyone: people who saved me or chat with me (the previous behaviour)
--   contacts: only people I saved
--   nobody:   no one
ALTER TABLE user_settings
  ADD COLUMN last_seen_visibility ENUM('everyone', 'contacts', 'nobody') NOT NULL DEFAULT 'everyone' AFTER sound_enabled;

-- Daily upload quota per user: sum of the bytes a user uploaded recently.
ALTER TABLE attachments
  ADD KEY idx_attachments_uploader_created (uploader_id, created_at);

-- migrate:down
ALTER TABLE attachments DROP KEY idx_attachments_uploader_created;
ALTER TABLE user_settings DROP COLUMN last_seen_visibility;
