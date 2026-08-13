const staleAccounts = new Map();

function key(userId, accountId) {
	return `${userId}:${accountId}`;
}

export function markAccountSyncFresh(userId, accountId) {
	staleAccounts.delete(key(userId, accountId));
}

export function markAccountSyncStale(userId, accountId, error) {
	staleAccounts.set(key(userId, accountId), {
		error: error?.message || String(error || 'Unknown sync error'),
		updatedAt: Date.now(),
	});
}

export function isAccountSyncStale(userId, accountId) {
	return staleAccounts.has(key(userId, accountId));
}

export function getAccountSyncState(userId, accountId) {
	const state = staleAccounts.get(key(userId, accountId));
	return state ? { stale: true, ...state } : { stale: false };
}

export function clearAccountSyncState(userId, accountId) {
	staleAccounts.delete(key(userId, accountId));
}
