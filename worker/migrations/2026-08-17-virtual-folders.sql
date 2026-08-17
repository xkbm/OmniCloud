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

CREATE INDEX IF NOT EXISTS idx_virtual_folders_user_parent ON virtual_folders(user_id, parent_path);
CREATE INDEX IF NOT EXISTS idx_virtual_folder_materializations_folder ON virtual_folder_materializations(virtual_folder_id, status);
CREATE INDEX IF NOT EXISTS idx_virtual_folder_materializations_user_account ON virtual_folder_materializations(user_id, cloud_account_id, status);
