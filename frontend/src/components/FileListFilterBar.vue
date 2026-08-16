<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { IconChevronDown, IconChevronRight, IconCloud, IconCloudFilled, IconCheck, IconPlus, IconSearch, IconX } from '@tabler/icons-vue';
import { useI18n } from 'vue-i18n';
import { getTypeFilterIcon } from '../composables/useFileType.js';
import { providerIcon, providerLabel } from '../composables/useFormatFile.js';
import { useFileTreeStore } from '../stores/fileTree';
import { useUploadQueueStore } from '../stores/uploadQueue';
import { api } from '../services/api';

const { t } = useI18n();
const fileTreeStore = useFileTreeStore();
const uploadQueueStore = useUploadQueueStore();

const fileInputRef = ref(null);
const folderInputRef = ref(null);
const newMenuRef = ref(null);
const isNewMenuOpen = ref(false);

const props = defineProps({
	typeOptions: { type: Array, required: true },
	ownerOptions: { type: Array, required: true },
	updatedOptions: { type: Array, required: true },
	selectedTypeFilter: { type: String, required: true },
	selectedOwnerFilter: { type: String, required: true },
	selectedUpdatedFilter: { type: String, required: true },
	activeFilterMenu: { type: [String, null], default: null },
	searchTerm: { type: String, default: '' },
});

const emit = defineEmits([
	'toggle-filter-menu',
	'apply-filter',
	'clear-filter',
	'update:searchTerm',
]);

function getFilterLabel(type, value) {
	if (type === 'type') return props.typeOptions.find((o) => o.value === value)?.label || t('filters.type');
	if (type === 'updated') return props.updatedOptions.find((o) => o.value === value)?.label || t('filters.modified');
	return value;
}

function renderOwnerLabel(value) {
	if (value === 'all') return t('filters.allOwners');
	const owner = props.ownerOptions.find((o) => o.key === value);
	if (!owner) return t('filters.allOwners');
	return `${owner.email} · ${providerLabel(owner.provider)}`;
}

function isFilterActive(type) {
	if (type === 'type') return props.selectedTypeFilter !== 'all';
	if (type === 'owner') return props.selectedOwnerFilter !== 'all';
	if (type === 'updated') return props.selectedUpdatedFilter !== 'all';
	return false;
}

function closeNewMenu() {
	isNewMenuOpen.value = false;
}

function toggleNewMenu() {
	isNewMenuOpen.value = !isNewMenuOpen.value;
}

function resetInput(inputRef) {
	if (inputRef.value) inputRef.value.value = '';
}

async function refreshCurrentFolder() {
	await fileTreeStore.loadFiles(fileTreeStore.currentPath);
}

async function handleUploads(entries) {
	if (!entries.length) return;
	closeNewMenu();
	try {
		await uploadQueueStore.uploadFiles(entries, fileTreeStore.currentPath, refreshCurrentFolder);
		await refreshCurrentFolder();
	} catch {
	}
}

function openFilePicker() {
	resetInput(fileInputRef);
	fileInputRef.value?.click();
}

function openFolderPicker() {
	resetInput(folderInputRef);
	folderInputRef.value?.click();
}

async function onFileInputChange(event) {
	await handleUploads(Array.from(event.target.files || []));
}

async function onFolderInputChange(event) {
	const entries = Array.from(event.target.files || []).map((file) => ({
		file,
		relativePath: file.webkitRelativePath || file.name,
	}));
	await handleUploads(entries);
}

async function createNewFolder() {
	closeNewMenu();
	const folderName = window.prompt(t('drive.newFolderName'));
	if (!folderName?.trim()) return;
	try {
		await uploadQueueStore.trackServerOperation(
			{ type: 'create-folder', name: folderName.trim(), targetKind: 'folder' },
			() => api.createFolder({ name: folderName.trim(), virtual_path: fileTreeStore.currentPath }),
		);
		await refreshCurrentFolder();
	} catch {
	}
}

function handleDocumentClick(event) {
	if (!newMenuRef.value?.contains(event.target)) closeNewMenu();
}

onMounted(() => document.addEventListener('click', handleDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', handleDocumentClick));
</script>

<template>
	<div class="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
		<input ref="fileInputRef" class="hidden" type="file" multiple @change="onFileInputChange" />
		<input ref="folderInputRef" class="hidden" type="file" multiple webkitdirectory directory @change="onFolderInputChange" />

		<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
			<div class="relative">
				<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#e0e3e7] bg-[#f8fafd] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'type')">
					<span>{{ getFilterLabel('type', selectedTypeFilter) }}</span>
					<IconX v-if="isFilterActive('type')" :size="16" :stroke="2" class="text-[#5f6368] transition hover:text-[#1a73e8] dark:text-slate-400 dark:hover:text-sky-300" @click.stop="emit('clear-filter', 'type')" />
					<IconChevronDown v-else :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>
				<div v-if="activeFilterMenu === 'type'" class="absolute right-0 top-full z-30 mt-2 min-w-[220px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<button v-for="option in typeOptions" :key="option.value" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm transition text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'type', option.value)">
						<span class="flex items-center gap-2">
							<component :is="getTypeFilterIcon(option.value, selectedTypeFilter === option.value)" :size="16" :stroke="selectedTypeFilter === option.value ? 0 : 1.8" :class="selectedTypeFilter === option.value ? 'text-[#1a73e8] dark:text-sky-300' : 'text-[#5f6368] dark:text-slate-400'" />
							<span>{{ option.label }}</span>
						</span>
						<IconCheck v-if="selectedTypeFilter === option.value" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>

			<div class="relative">
				<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#e0e3e7] bg-[#f8fafd] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'owner')">
					<span>{{ renderOwnerLabel(selectedOwnerFilter) }}</span>
					<IconX v-if="isFilterActive('owner')" :size="16" :stroke="2" class="text-[#5f6368] transition hover:text-[#1a73e8] dark:text-slate-400 dark:hover:text-sky-300" @click.stop="emit('clear-filter', 'owner')" />
					<IconChevronDown v-else :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>
				<div v-if="activeFilterMenu === 'owner'" class="absolute right-0 top-full z-30 mt-2 min-w-[260px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<button type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'owner', 'all')">
						<span class="flex min-w-0 items-center gap-2">
							<span class="flex size-5 shrink-0 items-center justify-center">
								<component :is="selectedOwnerFilter === 'all' ? IconCloudFilled : IconCloud" :size="16" :stroke="selectedOwnerFilter === 'all' ? 0 : 1.8" :class="selectedOwnerFilter === 'all' ? 'text-[#1a73e8] dark:text-sky-300' : 'text-[#5f6368] dark:text-slate-400'" />
							</span>
							<span>{{ t('filters.allOwners') }}</span>
						</span>
						<IconCheck v-if="selectedOwnerFilter === 'all'" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
					<button v-for="owner in ownerOptions" :key="owner.key" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'owner', owner.key)">
						<span class="flex min-w-0 items-center gap-2">
							<div v-if="providerIcon(owner.provider)" class="flex size-5 shrink-0 items-center justify-center rounded-full bg-white dark:bg-slate-900/70">
								<img :src="providerIcon(owner.provider)" :alt="providerLabel(owner.provider)" class="size-3.5 object-contain" />
							</div>
							<div v-else class="size-5 shrink-0"></div>
							<span class="flex min-w-0 flex-col">
								<span class="truncate">{{ owner.email }}</span>
							</span>
						</span>
						<IconCheck v-if="selectedOwnerFilter === owner.key" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>

			<div class="relative">
				<button type="button" class="inline-flex items-center gap-2 rounded-2xl border border-[#e0e3e7] bg-[#f8fafd] px-3.5 py-2.5 text-sm font-medium text-[#3c4043] transition hover:border-[#c7d2e0] hover:bg-white dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200 dark:hover:bg-slate-800" @click.stop="emit('toggle-filter-menu', 'updated')">
					<span>{{ getFilterLabel('updated', selectedUpdatedFilter) }}</span>
					<IconX v-if="isFilterActive('updated')" :size="16" :stroke="2" class="text-[#5f6368] transition hover:text-[#1a73e8] dark:text-slate-400 dark:hover:text-sky-300" @click.stop="emit('clear-filter', 'updated')" />
					<IconChevronDown v-else :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
				</button>
				<div v-if="activeFilterMenu === 'updated'" class="absolute right-0 top-full z-30 mt-2 min-w-[240px] overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white p-2 shadow-[0_16px_40px_rgba(32,33,36,0.16)] dark:border-slate-700 dark:bg-slate-800">
					<button v-for="option in updatedOptions" :key="option.value" type="button" class="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="emit('apply-filter', 'updated', option.value)">
						<span>{{ option.label }}</span>
						<IconCheck v-if="selectedUpdatedFilter === option.value" :size="16" :stroke="2" class="text-[#1a73e8] dark:text-sky-300" />
					</button>
				</div>
			</div>

			<div ref="newMenuRef" class="relative shrink-0">
				<button type="button" class="inline-flex h-11 items-center gap-2 rounded-2xl bg-gradient-to-r from-[#1a73e8] to-[#4f8ff7] px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(26,115,232,0.2)] transition hover:from-[#155fc4] hover:to-[#3f7fe0]" @click.stop="toggleNewMenu">
					<IconPlus :size="18" :stroke="2" />
					<span>{{ t('common.new') }}</span>
				</button>
				<div v-if="isNewMenuOpen" class="absolute left-0 top-[calc(100%+10px)] z-40 w-56 overflow-hidden rounded-2xl border border-[#e0e3e7] bg-white py-2 shadow-[0_12px_36px_rgba(60,64,67,0.2)] dark:border-slate-700 dark:bg-slate-800 dark:shadow-[0_12px_36px_rgba(15,23,42,0.45)]">
					<button type="button" class="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="createNewFolder">
						<span>{{ t('sidebar.newFolder') }}</span>
						<IconChevronRight :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
					</button>
					<button type="button" class="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="openFilePicker">
						<span>{{ t('sidebar.uploadFile') }}</span>
						<IconChevronRight :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
					</button>
					<button type="button" class="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-[#202124] hover:bg-[#f8fafd] dark:text-slate-100 dark:hover:bg-slate-700/70" @click="openFolderPicker">
						<span>{{ t('sidebar.uploadFolder') }}</span>
						<IconChevronRight :size="16" :stroke="2" class="text-[#5f6368] dark:text-slate-400" />
					</button>
				</div>
			</div>
		</div>

		<div class="relative ml-auto w-full min-w-0 shrink-0 sm:ml-0 sm:w-[280px]">
			<IconSearch :size="18" :stroke="2" class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#5f6368] dark:text-slate-400" />
			<input class="h-11 w-full rounded-full border border-[#dadce0] bg-white pl-11 pr-4 text-sm text-[#202124] outline-none transition focus:border-[#1a73e8] dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:border-sky-400" type="search" :value="searchTerm" :placeholder="t('drive.searchInFolder')" @input="emit('update:searchTerm', $event.target.value)" />
		</div>
	</div>
</template>
