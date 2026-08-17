ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (health_status IN ('healthy', 'degraded', 'offline', 'reauth_required'));

ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;

ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS health_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (health_failure_count >= 0);

CREATE INDEX IF NOT EXISTS idx_cloud_accounts_health
  ON cloud_accounts(user_id, health_status, health_checked_at);