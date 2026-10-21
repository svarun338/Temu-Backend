-- migrate:up
-- Server-side search reads only plaintext messages (an encrypted message's body is empty),
-- so it walks this index instead of every message in the user's chats.
ALTER TABLE messages ADD KEY idx_messages_plain (conversation_id, encrypted, id);

-- migrate:down
ALTER TABLE messages DROP KEY idx_messages_plain;
