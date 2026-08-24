import { computed, ref } from 'vue';
import { isCoarsePointerDevice } from '../utils/touchDevice.js';

export function useFileSelection({ sourceList, onBeforeSelect } = {}) {
	const selectedFileIds = ref(new Set());
	const lastSelectedFileId = ref(null);

	const selectedFiles = computed(() => {
		const ids = selectedFileIds.value;
		return sourceList.value.filter((file) => ids.has(file.id));
	});

	const selectedCount = computed(() => selectedFiles.value.length);
	const primarySelectedFile = computed(() => selectedFiles.value[0] || null);

	function isSelected(file) {
		return selectedFileIds.value.has(file.id);
	}

	function replaceSelection(file) {
		selectedFileIds.value = new Set([file.id]);
		lastSelectedFileId.value = file.id;
	}

	function toggleSelection(file) {
		const next = new Set(selectedFileIds.value);
		if (next.has(file.id)) {
			next.delete(file.id);
		} else {
			next.add(file.id);
		}
		selectedFileIds.value = next;
		lastSelectedFileId.value = file.id;
	}

	function selectRange(file) {
		const items = sourceList.value;
		const currentIndex = items.findIndex((item) => item.id === file.id);
		const anchorIndex = items.findIndex((item) => item.id === lastSelectedFileId.value);

		if (currentIndex === -1 || anchorIndex === -1) {
			replaceSelection(file);
			return;
		}

		const [start, end] = currentIndex < anchorIndex
			? [currentIndex, anchorIndex]
			: [anchorIndex, currentIndex];

		selectedFileIds.value = new Set(items.slice(start, end + 1).map((item) => item.id));
		lastSelectedFileId.value = file.id;
	}

	function selectItem(event, file) {
		event.preventDefault();
		event.stopPropagation();
		if (typeof onBeforeSelect === 'function') onBeforeSelect();

		if (event.shiftKey) {
			selectRange(file);
			return;
		}

		if (event.ctrlKey || event.metaKey) {
			toggleSelection(file);
			return;
		}

		// Touch devices: with an active multi-selection, tapping another item toggles
		// it (Google Drive pattern). Desktop keeps replace-on-click.
		if (isCoarsePointerDevice() && selectedFileIds.value.size > 0) {
			toggleSelection(file);
			return;
		}

		replaceSelection(file);
	}

	function clearSelection() {
		selectedFileIds.value = new Set();
		lastSelectedFileId.value = null;
	}

	return {
		selectedFileIds,
		lastSelectedFileId,
		selectedFiles,
		selectedCount,
		primarySelectedFile,
		isSelected,
		replaceSelection,
		toggleSelection,
		selectRange,
		selectItem,
		clearSelection,
	};
}
