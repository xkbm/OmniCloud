import { computed, ref } from 'vue';

export function useFileActionProgress() {
	const actionInProgress = ref(false);
	const actionLabel = ref('');

	const isActionInProgress = computed(() => actionInProgress.value);

	function setActionLabel(label) {
		if (!actionInProgress.value) return;
		actionLabel.value = String(label || '');
	}

	async function runWithProgress(label, task) {
		actionInProgress.value = true;
		actionLabel.value = label;
		try {
			return await task();
		} finally {
			actionInProgress.value = false;
			actionLabel.value = '';
		}
	}

	return {
		actionInProgress,
		actionLabel,
		isActionInProgress,
		setActionLabel,
		runWithProgress,
	};
}
