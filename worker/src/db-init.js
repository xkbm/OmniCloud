import { sql } from './db.js';
import { SCHEMA_SQL, MIGRATIONS } from '../generated/schema-string.js';

// Auto-initializes the database on first boot. If the users table exists,
// the database is considered initialized and this is a no-op.
// Safe to race: every statement uses IF NOT EXISTS.

let initPromise = null;

export function ensureDbInitialized(env) {
	if (!initPromise) {
		initPromise = doInit(env).catch((error) => {
			initPromise = null; // allow retry on next request
			console.error('[db-init] failed:', error.message);
		});
	}
	return initPromise;
}

async function doInit(env) {
	const db = sql(env);
	const check = await db`SELECT COUNT(*)::int AS tables FROM information_schema.tables WHERE table_schema='public' AND table_name='users'`;
	if ((check[0]?.tables || 0) > 0) return;

	console.log('[db-init] Empty database detected — applying schema and migrations...');
	await db.unsafe(SCHEMA_SQL);
	for (const migration of MIGRATIONS) {
		try {
			await db.unsafe(migration.sql);
			await db`INSERT INTO _applied_migrations (name) VALUES (${migration.name}) ON CONFLICT (name) DO NOTHING`;
			console.log(`[db-init] applied ${migration.name}`);
		} catch (error) {
			console.warn(`[db-init] skipped ${migration.name}:`, error.message?.slice(0, 120));
		}
	}
	console.log('[db-init] Database ready.');
}
