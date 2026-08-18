-- Cloudflare Worker persistence schema.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  is_local BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cloud_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  total_space BIGINT NOT NULL,
  used_space BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'invalid_token')),
  health_status TEXT NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'degraded', 'offline', 'reauth_required')),
  health_checked_at TIMESTAMPTZ,
  health_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (health_failure_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'healthy'
    CHECK (health_status IN ('healthy', 'degraded', 'offline', 'reauth_required'));
ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;
ALTER TABLE cloud_accounts
  ADD COLUMN IF NOT EXISTS health_failure_count INTEGER NOT NULL DEFAULT 0
    CHECK (health_failure_count >= 0);

CREATE TABLE IF NOT EXISTS file_metadata (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  virtual_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  is_folder BOOLEAN NOT NULL DEFAULT FALSE,
  is_starred BOOLEAN NOT NULL DEFAULT FALSE,
  size BIGINT NOT NULL DEFAULT 0,
  mime_type TEXT,
  cloud_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  remote_file_id TEXT NOT NULL,
  remote_parent_id TEXT,
  remote_created_time TIMESTAMPTZ,
  remote_modified_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS virtual_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_path TEXT NOT NULL DEFAULT '/',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_virtual_folders_user_path UNIQUE (user_id, path),
  CONSTRAINT uq_virtual_folders_user_parent_name UNIQUE (user_id, parent_path, name)
);

CREATE TABLE IF NOT EXISTS virtual_folder_materializations (
  id TEXT PRIMARY KEY,
  virtual_folder_id TEXT NOT NULL REFERENCES virtual_folders(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloud_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  remote_file_id TEXT NOT NULL,
  remote_parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_virtual_folder_materialization_remote UNIQUE (cloud_account_id, remote_file_id),
  CONSTRAINT uq_virtual_folder_materialization_account UNIQUE (virtual_folder_id, cloud_account_id)
);

CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloud_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size BIGINT NOT NULL DEFAULT 0,
  virtual_path TEXT NOT NULL DEFAULT '/',
  remote_parent_id TEXT,
  duplicate_policy TEXT NOT NULL DEFAULT 'rename',
  status TEXT NOT NULL DEFAULT 'pending',
  reservation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS duplicate_policy TEXT NOT NULL DEFAULT 'rename';
ALTER TABLE upload_sessions
  ADD COLUMN IF NOT EXISTS reservation_id TEXT;

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

ALTER TABLE upload_sessions
  DROP CONSTRAINT IF EXISTS fk_upload_sessions_reservation;
ALTER TABLE upload_sessions
  ADD CONSTRAINT fk_upload_sessions_reservation
  FOREIGN KEY (reservation_id) REFERENCES storage_reservations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS operation_sagas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cloud_account_id TEXT NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES file_metadata(id) ON DELETE SET NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upload', 'move', 'delete', 'rename')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('pending_remote', 'remote_succeeded', 'completed', 'failed', 'pending_reconcile')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_user_provider_email ON cloud_accounts(user_id, provider, email);
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_user_id ON cloud_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_health ON cloud_accounts(user_id, health_status, health_checked_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at);
CREATE INDEX IF NOT EXISTS idx_file_virtual_path ON file_metadata(user_id, virtual_path);
CREATE INDEX IF NOT EXISTS idx_file_remote_id ON file_metadata(user_id, remote_file_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_account_remote_id ON file_metadata(cloud_account_id, remote_file_id);
CREATE INDEX IF NOT EXISTS idx_file_user_account_id ON file_metadata(user_id, cloud_account_id);
CREATE INDEX IF NOT EXISTS idx_virtual_folders_user_parent ON virtual_folders(user_id, parent_path);
CREATE INDEX IF NOT EXISTS idx_virtual_folder_materializations_folder ON virtual_folder_materializations(virtual_folder_id, status);
CREATE INDEX IF NOT EXISTS idx_virtual_folder_materializations_user_account ON virtual_folder_materializations(user_id, cloud_account_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user_key ON user_settings(user_id, key);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON upload_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_policy ON upload_sessions(duplicate_policy, status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_reservation ON upload_sessions(reservation_id);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_account_active ON storage_reservations(cloud_account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_storage_reservations_user_status ON storage_reservations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_operation_sagas_status ON operation_sagas(status, created_at);
CREATE INDEX IF NOT EXISTS idx_operation_sagas_user ON operation_sagas(user_id, status, created_at);