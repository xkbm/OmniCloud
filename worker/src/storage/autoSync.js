import { sql } from '../db.js';
import { syncStorageAccount } from '../providers/storage.js';

// Scheduled auto-sync: heals metadata drift against providers without any
// manual action. Claim-first via synced_at bump prevents overlapping runs —
// a failed attempt simply waits for the next interval.

export function autoSyncIntervalMinutes(env) {
	const value = Number(env.AUTO_SYNC_INTERVAL_MINUTES);
	return Number.isFinite(value) && value >= 0 ? value : 60;
}

export async function runAutoSync(env) {
	const interval = autoSyncIntervalMinutes(env);
	if (!interval) return { skipped: 'disabled' };
	const db = sql(env);
	const due = await db`
		SELECT id, user_id, provider, email, encrypted_credentials,
		       total_space, used_space, status
		FROM cloud_accounts
		WHERE status='active'
			AND (synced_at IS NULL OR synced_at < NOW() - make_interval(mins => ${interval}))
	`;
	const results = [];
	for (const account of due) {
		const claimed = await db`
			UPDATE cloud_accounts SET synced_at=NOW(), updated_at=NOW()
			WHERE id=${account.id}
				AND (synced_at IS NULL OR synced_at < NOW() - make_interval(mins => ${interval}))
			RETURNING id`;
		if (!claimed.length) continue;
		const startedAt = Date.now();
		try {
			const outcome = await syncStorageAccount(env, account.user_id, account);
			const summary = { account: account.email || account.id, provider: account.provider, count: outcome?.count ?? null, ms: Date.now() - startedAt };
			results.push({ ...summary, ok: true });
			console.log('[auto-sync] completed', JSON.stringify(summary));
		} catch (error) {
			const summary = { account: account.email || account.id, message: String(error?.message || error).slice(0, 300), ms: Date.now() - startedAt };
			results.push({ ...summary, ok: false });
			console.error('[auto-sync] failed:', JSON.stringify(summary));
		}
	}
	console.log('[auto-sync] cycle', JSON.stringify({ due: due.length, ok: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length }));
	return { due: due.length, results };
}
