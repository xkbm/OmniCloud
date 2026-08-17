CREATE TABLE IF NOT EXISTS storage_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloud_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  upload_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')) DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_reservations_account_active
  ON storage_reservations(cloud_account_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_storage_reservations_user_status
  ON storage_reservations(user_id, status);

ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS reservation_id TEXT REFERENCES storage_reservations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_upload_sessions_reservation
  ON upload_sessions(reservation_id);
