import Database from 'better-sqlite3';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const SNAPSHOT_TABLE = 'public.omnicloud_sqlite_state';

if (!DATABASE_URL) {
	throw new Error('DATABASE_URL is required. OmniCloud persistence is configured for Neon PostgreSQL.');
}

const pool = new Pool({
	connectionString: DATABASE_URL,
	max: 2,
	idleTimeoutMillis: 30_000,
	connectionTimeoutMillis: 10_000,
	ssl: DATABASE_URL.includes('sslmode=') ? undefined : { rejectUnauthorized: false },
});

await pool.query(`
	CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (
		id INTEGER PRIMARY KEY,
		db BYTEA NOT NULL,
		updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)
`);

let snapshot = null;
try {
	const result = await pool.query(`SELECT db FROM ${SNAPSHOT_TABLE} WHERE id = 1`);
	if (result.rows[0]?.db) {
		snapshot = Buffer.isBuffer(result.rows[0].db)
			? result.rows[0].db
			: Buffer.from(result.rows[0].db);
	}
} catch (error) {
	await pool.end();
	throw new Error(`Failed to load OmniCloud database snapshot from Neon: ${error.message}`);
}

// Restore a serialized better-sqlite3 database into an in-memory instance.
const rawDb = new Database(':memory:');
if (snapshot) rawDb.deserialize(snapshot);
rawDb.pragma('foreign_keys = ON');

export const LOCAL_USER_ID = 'local-default-user';
export const LOCAL_USER_EMAIL = 'local@omnicloud.local';

rawDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    is_local INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cloud_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    email TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_credentials TEXT NOT NULL,
    total_space INTEGER NOT NULL,
    used_space INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'invalid_token')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS file_metadata (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    virtual_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    is_folder INTEGER NOT NULL DEFAULT 0,
	is_starred INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    cloud_account_id TEXT NOT NULL,
    remote_file_id TEXT NOT NULL,
    remote_parent_id TEXT,
    remote_created_time TEXT,
    remote_modified_time TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(cloud_account_id) REFERENCES cloud_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

rawDb.prepare(`
  INSERT OR IGNORE INTO users (id, email, password_hash, is_local)
  VALUES (?, ?, '', 1)
`).run(LOCAL_USER_ID, LOCAL_USER_EMAIL);

rawDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_accounts_user_provider_email
    ON cloud_accounts(user_id, provider, email);
  CREATE INDEX IF NOT EXISTS idx_cloud_accounts_user_id
    ON cloud_accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_file_virtual_path ON file_metadata(user_id, virtual_path);
  CREATE INDEX IF NOT EXISTS idx_file_remote_id ON file_metadata(user_id, remote_file_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_file_account_remote_id
    ON file_metadata(cloud_account_id, remote_file_id);
  CREATE INDEX IF NOT EXISTS idx_file_user_account_id
    ON file_metadata(user_id, cloud_account_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user_key
    ON user_settings(user_id, key);
`);

let dirty = false;
let persistTimer = null;
let writeDepth = 0;
let persistInFlight = null;

async function persistSnapshot() {
	if (persistInFlight) return persistInFlight;
	if (!dirty) return;

	dirty = false;
	const bytes = Buffer.from(rawDb.serialize());
	persistInFlight = pool
		.query(
			`INSERT INTO ${SNAPSHOT_TABLE} (id, db, updated_at)
			 VALUES (1, $1, NOW())
			 ON CONFLICT (id) DO UPDATE
			 SET db = EXCLUDED.db, updated_at = EXCLUDED.updated_at`,
			[bytes],
		)
		.catch((error) => {
			dirty = true;
			console.error('Failed to persist OmniCloud database snapshot to Neon:', error);
			throw error;
		})
		.finally(() => {
			persistInFlight = null;
		});

	return persistInFlight;
}

function schedulePersist() {
	dirty = true;
	if (writeDepth > 0 || persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = null;
		void persistSnapshot().catch(() => {});
	}, 100);
}

function wrapStatement(statement) {
	return new Proxy(statement, {
		get(target, property, receiver) {
			if (property === 'run') {
				return (...args) => {
					const result = target.run(...args);
					schedulePersist();
					return result;
				};
			}

			const value = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

const db = new Proxy(rawDb, {
	get(target, property, receiver) {
		if (property === 'prepare') {
			return (...args) => wrapStatement(target.prepare(...args));
		}

		if (property === 'exec') {
			return (...args) => {
				const result = target.exec(...args);
				schedulePersist();
				return result;
			};
		}

		if (property === 'transaction') {
			return (...args) => {
				const transaction = target.transaction(...args);
				return (...transactionArgs) => {
					writeDepth += 1;
					try {
						return transaction(...transactionArgs);
					} finally {
						writeDepth -= 1;
						schedulePersist();
					}
				};
			};
		}

		const value = Reflect.get(target, property, receiver);
		return typeof value === 'function' ? value.bind(target) : value;
	},
});

export { db };

schedulePersist();

async function flushAndClose() {
	if (persistTimer) {
		clearTimeout(persistTimer);
		persistTimer = null;
	}

	if (dirty) {
		try {
			await persistSnapshot();
		} catch {
			// The process is already shutting down; keep the original error in logs.
		}
	}

	await pool.end();
	rawDb.close();
}

process.once('SIGTERM', () => {
	void flushAndClose().finally(() => process.exit(0));
});
process.once('SIGINT', () => {
	void flushAndClose().finally(() => process.exit(0));
});
