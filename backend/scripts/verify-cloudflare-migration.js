import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

dotenvCheck();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempPath = path.join(os.tmpdir(), `omnicloud-verify-${randomUUID()}.db`);
const pool = new Pool({ connectionString: DATABASE_URL, max: 1, ssl: DATABASE_URL.includes('sslmode=') ? undefined : { rejectUnauthorized: false } });
const client = await pool.connect();
const mutableTables = ['users', 'cloud_accounts', 'file_metadata', 'user_settings'];
const ephemeralTables = ['auth_sessions'];

function dotenvCheck() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
}

try {
  const snapshotResult = await client.query('SELECT db FROM public.omnicloud_sqlite_state WHERE id = 1');
  const snapshot = snapshotResult.rows[0]?.db;
  if (!snapshot) throw new Error('No SQLite snapshot found');
  fs.writeFileSync(tempPath, snapshot);
  const sqlite = new Database(tempPath, { readonly: true });

  const mismatches = [];
  for (const table of mutableTables) {
    const sqliteTable = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    const sourceCount = sqliteTable ? Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count) : 0;
    const target = await client.query(`SELECT COUNT(*)::bigint AS count FROM public."${table}"`);
    const targetCount = Number(target.rows[0].count);
    console.log(`${table}: source=${sourceCount} target=${targetCount} (post-migration rows are allowed)`);
    if (targetCount < sourceCount) {
      mismatches.push(`${table}: target=${targetCount} is below snapshot source=${sourceCount}`);
    }
  }

  for (const table of ephemeralTables) {
    const sqliteTable = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    const sourceCount = sqliteTable ? Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count) : 0;
    const target = await client.query(`SELECT COUNT(*)::bigint AS count FROM public."${table}"`);
    const targetCount = Number(target.rows[0].count);
    console.log(`${table}: source=${sourceCount} target=${targetCount} (ephemeral; extra sessions are allowed)`);
    if (targetCount < sourceCount) mismatches.push(`${table}: target=${targetCount} is below snapshot source=${sourceCount}`);
  }

  sqlite.close();
  if (mismatches.length) throw new Error(`Migration parity check failed: ${mismatches.join('; ')}`);
  console.log('Migration data parity verified successfully.');
} finally {
  client.release();
  await pool.end();
  try { fs.rmSync(tempPath, { force: true }); } catch {}
}
