import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { formatBytesStrict } from './useFormatFile.js';
import { useAccountManagementStore } from '../stores/accountManagement';
import { api } from '../services/api';

const STORAGE_REFRESH_MS = 30000;

export function useStorageStats() {
	const accountStore = useAccountManagementStore();
	const { accounts } = storeToRefs(accountStore);
	const { t } = useI18n();
	const poolStats = ref(null);
	let refreshTimer = null;

	async function refreshPoolStats() {
		try {
			const response = await api.getStorage();
			poolStats.value = response?.data || null;
		} catch {
			poolStats.value = null;
		}
	}

	onMounted(() => {
		refreshPoolStats();
		refreshTimer = window.setInterval(refreshPoolStats, STORAGE_REFRESH_MS);
	});

	onBeforeUnmount(() => {
		if (refreshTimer) window.clearInterval(refreshTimer);
	});

	const totalUsed = computed(() => {
		if (poolStats.value) return Number(poolStats.value.used || 0);
		return accounts.value.reduce((sum, account) => sum + Number(account.used_space || 0), 0);
	});

	const totalSpace = computed(() => {
		if (poolStats.value) return Number(poolStats.value.capacity || 0);
		return accounts.value.reduce((sum, account) => sum + Number(account.total_space || 0), 0);
	});

	const totalFree = computed(() => Math.max(0, Number(poolStats.value?.free ?? (totalSpace.value - totalUsed.value))));

	const storagePercent = computed(() => {
		if (!totalSpace.value) return 0;
		return Math.min(100, (totalUsed.value / totalSpace.value) * 100);
	});

	const storagePercentRounded = computed(() => Math.round(storagePercent.value));

	const usedFormatted = computed(() => formatBytesStrict(totalUsed.value));
	const totalFormatted = computed(() => formatBytesStrict(totalSpace.value));
	const freeFormatted = computed(() => formatBytesStrict(totalFree.value));

	const storageLabel = computed(() =>
		t('sidebar.storageUsed', { used: usedFormatted.value, total: totalFormatted.value }),
	);

	const usedTotalLabel = computed(() => `${usedFormatted.value} / ${totalFormatted.value}`);

	return {
		accounts,
		poolStats,
		totalUsed,
		totalSpace,
		totalFree,
		storagePercent,
		storagePercentRounded,
		usedFormatted,
		totalFormatted,
		freeFormatted,
		storageLabel,
		usedTotalLabel,
	};
}
