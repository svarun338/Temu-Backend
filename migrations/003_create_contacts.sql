-- A row means "user_id saved contact_user_id to their contact list" (one-directional).
-- migrate:up
CREATE TABLE contacts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  contact_user_id BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contacts_pair (user_id, contact_user_id),
  KEY idx_contacts_contact_user (contact_user_id),
  CONSTRAINT fk_contacts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_contacts_contact_user FOREIGN KEY (contact_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_contacts_not_self CHECK (user_id <> contact_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:down
DROP TABLE IF EXISTS contacts;
