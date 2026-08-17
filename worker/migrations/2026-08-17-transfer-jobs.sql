CREATE TABLE IF NOT EXISTS transfer_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('move', 'copy')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'verifying', 'completed', 'failed', 'cancelled')) DEFAULT 'queued',
  source_file_id TEXT REFERENCES file_metadata(id) ON DELETE SET NULL,
  destination_folder_id TEXT REFERENCES file_metadata(id) ON DELETE SET NULL,
  total_nodes INTEGER NOT NULL CHECK (total_nodes >= 0),
  completed_nodes INTEGER NOT NULL DEFAULT 0 CHECK (completed_nodes >= 0),
  bytes_total BIGINT NOT NULL DEFAULT 0 CHECK (bytes_total >= 0),
  bytes_completed BIGINT NOT NULL DEFAULT 0 CHECK (bytes_completed >= 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transfer_jobs_user_status
  ON transfer_jobs(user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_transfer_jobs_status_created
  ON transfer_jobs(status, created_at);
