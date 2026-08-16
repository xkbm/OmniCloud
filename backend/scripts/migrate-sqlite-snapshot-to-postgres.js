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
const schemaPath = path.resolve(__dirname, '../../worker/schema.sql');
const tempPath = path.join(os.tmpdir(), `omnicloud-snapshot-${randomUUID()}.db`);

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
