// Applies worker/schema.sql + worker/migrations/*.sql to any Postgres database.
// Idempotent: schema.sql uses IF NOT EXISTS everywhere; migration files are
// tracked in a _applied_migrations ledger so they never run twice.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/db-apply.mjs
//   node scripts/db-apply.mjs postgres://...
//
// Uses @neondatabase/serverless Pool (WebSocket), so plain postgres:// and
// neon:// connection strings both work — including from a local machine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, neonConfig } from '@neondatabase/serverless';

const here = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.argv[2] || process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error('Usage: node scripts/db-apply.mjs <DATABASE_URL>   (or set DATABASE_URL env)');
	process.exit(1);
}

// Node >=22 exposes a global WebSocket; fall back to `ws` when present.
if (!globalThis.WebSocket) {
	try {
		const wsModule = await import('ws');
		neonConfig.webSocketConstructor = wsModule.default;
	} catch {
		console.error('No WebSocket implementation available (need Node >=22 or the `ws` package).');
		process.exit(1);
	}
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('sslmode=disable') ? undefined : { rejectUnauthorized: false } });
const client = await pool.connect();

async function applyFile(label, sqlText) {
	await client.query('BEGIN');
	try {
		await client.query(sqlText);
		if (label !== 'schema.sql') {
			await client.query(
				'INSERT INTO _applied_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
				[label],
			);
		}
		await client.query('COMMIT');
		console.log(`✔ ${label}`);
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		console.error(`✖ ${label}:`, error.message);
		throw error;
	}
}

try {
	await client.query(`
		CREATE TABLE IF NOT EXISTS _applied_migrations (
			name TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`);

	const schemaPath = path.join(here, '..', 'schema.sql');
	await applyFile('schema.sql', fs.readFileSync(schemaPath, 'utf8'));

	const migrationsDir = path.join(here, '..', 'migrations');
	const files = fs.readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort();
	for (const name of files) {
		const applied = await client.query('SELECT 1 FROM _applied_migrations WHERE name = $1', [name]);
		if (applied.rowCount) {
			console.log(`• ${name} (already applied)`);
			continue;
		}
		await applyFile(name, fs.readFileSync(path.join(migrationsDir, name), 'utf8'));
	}

	console.log('Database schema up to date.');
} finally {
	client.release();
	await pool.end();
}
