import cron from 'node-cron';
import { env } from '../config/env.js';
import { LOCAL_USER_ID } from '../config/database.js';
import { getActiveAccounts, markAccountStatus, updateAccountStorage } from './accountService.js';
import { createAdapter } from './adapterRegistry.js';
import { clearFilesForAccount, replaceFilesForAccount } from './fileService.js';
import { markAccountSyncFresh, markAccountSyncStale } from './syncStateService.js';
import { isAuthError, withRetry } from '../utils/providerErrors.js';

async function fetchAccountSnapshot(account) {
	return withRetry(
		async () => {
			const adapter = createAdapter(account);
			const remoteFiles = await adapter.fetchStructure();
			const storage = await adapter.getStorageSummary();

			if (!Array.isArray(remoteFiles)) {
				throw new Error('Provider returned an invalid file structure');
			}

			if (!storage || typeof storage !== 'object') {
				throw new Error('Provider returned an invalid storage summary');
			}

			return { remoteFiles, storage };
		},
		{
			retries: 3,
			onRetry: (error, attempt) => {
				console.warn(
					`Transient sync error for ${account.email} (attempt ${attempt}), retrying:`,
					error?.message || error,
				);
			},
		},
	);
}

function handleSyncFailure(account, error) {
	markAccountSyncStale(account.user_id, account.id, error);

	if (isAuthError(error)) {
		clearFilesForAccount(account.user_id, account.id);
		markAccountStatus(account.user_id, account.id, 'invalid_token');
		console.error(`Auth error for account ${account.email}, marked invalid_token:`, error.message);
		return;
	}

	// Do not leave a potentially stale catalog visible when the provider state
	// cannot be confirmed. The next successful sync will repopulate it.
	clearFilesForAccount(account.user_id, account.id);
	console.error(
		`Transient sync failure for account ${account.email} (kept connected, catalog cleared until next successful sync):`,
		error.message,
	);
}

let lastSyncReport = {
	lastRunAt: null,
	userId: null,
	scannedAccounts: 0,
	changesDetected: 0,
};

let activeSyncPromise = null;

export async function runDeltaSync(userId) {
	if (activeSyncPromise) {
		return activeSyncPromise;
	}

	activeSyncPromise = (async () => {
		const accounts = getActiveAccounts(userId);
		let changesDetected = 0;

		for (const account of accounts) {
			try {
				const { remoteFiles, storage } = await fetchAccountSnapshot(account);

				replaceFilesForAccount(userId, account.id, remoteFiles);
				updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);
				markAccountSyncFresh(userId, account.id);
				changesDetected += remoteFiles.length;
			} catch (error) {
				handleSyncFailure(account, error);
			}
		}

		lastSyncReport = {
			lastRunAt: new Date().toISOString(),
			userId,
			scannedAccounts: accounts.length,
			changesDetected,
		};

		return lastSyncReport;
	})();

	try {
		return await activeSyncPromise;
	} finally {
		activeSyncPromise = null;
	}
}

export function scheduleSync() {
	const interval = Math.max(1, env.syncIntervalMinutes);
	cron.schedule(`*/${interval} * * * *`, () => {
		if (env.appMode !== 'local') {
			return;
		}
		runDeltaSync(LOCAL_USER_ID).catch((error) => {
			console.error('Delta sync failed:', error);
		});
	});
}

export function getLastSyncReport() {
	return {
		...lastSyncReport,
		isRunning: Boolean(activeSyncPromise),
	};
}

export async function syncAccount(userId, account) {
	try {
		const { remoteFiles, storage } = await fetchAccountSnapshot(account);

		replaceFilesForAccount(userId, account.id, remoteFiles);
		updateAccountStorage(userId, account.id, storage.totalSpace, storage.usedSpace);
		markAccountSyncFresh(userId, account.id);

		return {
			accountId: account.id,
			filesSynced: remoteFiles.length,
			totalSpace: storage.totalSpace,
			usedSpace: storage.usedSpace,
			syncFailed: false,
		};
	} catch (error) {
		handleSyncFailure(account, error);
		return {
			accountId: account.id,
			filesSynced: 0,
			totalSpace: Number(account.total_space || 0),
			usedSpace: Number(account.used_space || 0),
			syncFailed: true,
		};
	}
}
