CREATE TABLE IF NOT EXISTS operation_sagas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloud_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES file_metadata(id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upload','move','delete','rename')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending_remote','remote_succeeded','completed','failed','pending_reconcile')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operation_sagas_status
  ON operation_sagas(status, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_sagas_user
  ON operation_sagas(user_id, status, created_at);
