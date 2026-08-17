ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS duplicate_policy TEXT NOT NULL DEFAULT 'rename';
CREATE INDEX IF NOT EXISTS idx_upload_sessions_policy ON upload_sessions(duplicate_policy, status);
