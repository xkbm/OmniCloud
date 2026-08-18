import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.join(here, 'migrate-sqlite-snapshot-to-postgres.js'), 'utf8');
const schema = fs.readFileSync(path.join(here, '../../worker/schema.sql'), 'utf8');
const migrationsDir = path.join(here, '../../worker/migrations');

const migrations = [
  '2026-08-17-p2.sql',
  '2026-08-17-p2-upload-policy.sql',
  '2026-08-17-storage-health.sql',
  '2026-08-17-storage-reservations.sql',
  '2026-08-17-transfer-jobs.sql',
  '2026-08-17-virtual-folders.sql',
  '2026-08-18-rebalance-idempotency.sql',
];

if (!schema.includes('ADD COLUMN IF NOT EXISTS health_status')) {
  throw new Error('schema.sql must add health_status for pre-existing cloud_accounts');
}
if (!schema.includes('CREATE INDEX IF NOT EXISTS idx_cloud_accounts_health')) {
  throw new Error('schema.sql must create the health index after the compatibility ALTERs');
}
if (!script.includes('async function ensurePreexistingCloudAccountsCompatibility()')) {
  throw new Error('migrator must preflight pre-existing cloud_accounts before schema/index creation');
}
if (!script.includes('await ensurePreexistingCloudAccountsCompatibility();')) {
  throw new Error('migrator must run the cloud_accounts compatibility preflight');
}

const listMatch = script.match(/const MIGRATIONS = \[([\s\S]*?)\];/);
if (!listMatch) throw new Error('migrator must declare an explicit MIGRATIONS list');

for (const fileName of migrations) {
  if (!listMatch[1].includes(`'${fileName}'`)) {
    throw new Error(`migrator is missing ${fileName}`);
  }
  if (!fs.existsSync(path.join(migrationsDir, fileName))) {
    throw new Error(`migration file is missing: ${fileName}`);
  }
}

if (!script.includes('await client.query(schema);')) {
  throw new Error('migrator must apply schema.sql');
}
if (!script.includes('await applyCloudflareMigrations();')) {
  throw new Error('migrator must apply versioned Cloudflare migrations');
}
if (!script.includes('await client.query(\'BEGIN\');') || !script.includes('await client.query(\'COMMIT\');')) {
  throw new Error('schema and migrations must remain transactional');
}

console.log('Cloudflare migration contract verified.');
