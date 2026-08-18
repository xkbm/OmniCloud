import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

dotenv.config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerRoot = path.resolve(__dirname, '../../worker');
const schemaPath = path.join(workerRoot, 'schema.sql');
const migrationsDir = path.join(workerRoot, 'migrations');
const tempPath = path.join(os.tmpdir(), `omnicloud-snapshot-${randomUUID()}.db`);

const MIGRATIONS = [
  '2026-08-17-p2.sql',
  '2026-08-17-p2-upload-policy.sql',
  '2026-08-17-storage-health.sql',
  '2026-08-17-storage-reservations.sql',
  '2026-08-17-transfer-jobs.sql',
  '2026-08-17-virtual-folders.sql',
  '2026-08-18-rebalance-idempotency.sql',
];

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 1,
  ssl: DATABASE_URL.includes('sslmode=') ? undefined : { rejectUnauthorized: false },
});

const client = await pool.connect();

function normalizeBoolean(value) {
  return Boolean(Number(value));
}

function toValue(table, column, value) {
  if (value === null || value === undefined) return null;
  if ((table === 'users' && column === 'is_local') ||
      (table === 'file_metadata' && (column === 'is_folder' || column === 'is_starred'))) {
    return normalizeBoolean(value);
  }
  return value;
}

async function insertRows(table, rows, columns) {
  if (!rows.length) return;

  const quotedColumns = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
  for (const row of rows) {
    const values = columns.map((column) => toValue(table, column, row[column]));
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
      `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

async function applyCloudflareMigrations() {
  for (const fileName of MIGRATIONS) {
    const migrationPath = path.join(migrationsDir, fileName);
    const migration = fs.readFileSync(migrationPath, 'utf8');
    await client.query(migration);
    console.log(`Applied Cloudflare migration ${fileName}`);
  }
}

try {
  const snapshotResult = await client.query(
    'SELECT db FROM public.omnicloud_sqlite_state WHERE id = 1',
  );
  const snapshot = snapshotResult.rows[0]?.db;
  if (!snapshot) throw new Error('No SQLite snapshot found in public.omnicloud_sqlite_state');

  fs.writeFileSync(tempPath, snapshot);
  const sqlite = new Database(tempPath, { readonly: true });

  const schema = fs.readFileSync(schemaPath, 'utf8');
  await client.query('BEGIN');
  await client.query(schema);
  await applyCloudflareMigrations();

  const tables = [
    'users',
    'auth_sessions',
    'cloud_accounts',
    'file_metadata',
    'user_settings',
  ];

  for (const table of tables) {
    const columns = sqlite
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((column) => column.name);

    if (!columns.length) {
      console.log(`Skipping ${table}: table does not exist in snapshot`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
    await insertRows(table, rows, columns);
    console.log(`Migrated ${rows.length} rows from ${table}`);
  }

  sqlite.close();
  await client.query('COMMIT');
  console.log('Migration complete. The original SQLite snapshot was left untouched.');
} catch (error) {
  try {
    await client.query('ROLLBACK');
  } catch {}
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
  try {
    fs.rmSync(tempPath, { force: true });
  } catch {}
}
