-- Cloudflare Worker persistence schema.
-- This replaces the SQLite snapshot architecture used by the Render backend.
-- Run this only against the migration/test database after backing it up.

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

CREATE TABLE IF NOT EXISTS cloud_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  total_space BIGINT NOT NULL,
  used_space BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'invalid_token')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_user_provider_email
  ON cloud_accounts(user_id, provider, email);
CREATE INDEX IF NOT EXISTS idx_cloud_accounts_user_id
  ON cloud_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id
  ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_file_virtual_path
  ON file_metadata(user_id, virtual_path);
CREATE INDEX IF NOT EXISTS idx_file_remote_id
  ON file_metadata(user_id, remote_file_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_account_remote_id
  ON file_metadata(cloud_account_id, remote_file_id);
CREATE INDEX IF NOT EXISTS idx_file_user_account_id
  ON file_metadata(user_id, cloud_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user_key
  ON user_settings(user_id, key);
