<script setup>
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconBrandGithub, IconExternalLink, IconGitCommit, IconLoader2, IconRefresh, IconStarFilled, IconX } from '@tabler/icons-vue';

const props = defineProps({
	open: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

const { t, locale } = useI18n();

const isLoading = ref(false);
const errorMessage = ref('');
const commits = ref([]);
const stars = ref(null);
const lastFetchedAt = ref(null);

const starsLabel = computed(() => {
	if (stars.value === null) {
		return '—';
	}

	return new Intl.NumberFormat('en', { notation: stars.value >= 1000 ? 'compact' : 'standard' }).format(stars.value);
});

function closeModal() {
	emit('close');
}

function formatDate(dateString) {
	if (!dateString) {
		return t('updates.dateUnavailable');
	}

	return new Intl.DateTimeFormat(locale.value === 'id' ? 'id-ID' : 'en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date(dateString));
}

function shortSha(sha) {
	return sha?.slice(0, 7) ?? 'commit';
}

function normalizeCommit(commit) {
	return {
		sha: commit.sha,
		message: commit.commit?.message?.split('\n')[0] || t('updates.fallbackCommitMessage'),
		author: commit.commit?.author?.name || commit.author?.login || t('updates.fallbackAuthor'),
		date: commit.commit?.author?.date,
		url: commit.html_url,
	};
}

async function loadUpdates({ force = false } = {}) {
	if (isLoading.value || (!force && commits.value.length && stars.value !== null)) {
		return;
	}

	isLoading.value = true;
	errorMessage.value = '';

	try {
		const [repoResponse, commitsResponse] = await Promise.all([
			fetch('https://api.github.com/repos/xkbm/omnicloud', { headers: { Accept: 'application/vnd.github+json' } }),
			fetch('https://api.github.com/repos/xkbm/omnicloud/commits?per_page=6', { headers: { Accept: 'application/vnd.github+json' } }),
		]);

		if (!repoResponse.ok || !commitsResponse.ok) {
			throw new Error(t('updates.fetchError'));
		}

		const [repoData, commitsData] = await Promise.all([repoResponse.json(), commitsResponse.json()]);

		stars.value = repoData.stargazers_count ?? 0;
		commits.value = Array.isArray(commitsData) ? commitsData.map(normalizeCommit) : [];
		lastFetchedAt.value = new Date();
	} catch (error) {
		errorMessage.value = error?.message || t('updates.genericError');
	} finally {
		isLoading.value = false;
	}
}

watch(
	() => props.open,
	(open) => {
		if (open) {
			loadUpdates();
		}
	},
);
</script>

<template>
	<Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
		<div v-if="open" class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 px-4 py-8 backdrop-blur-sm" @click.self="closeModal">
			<div class="relative flex max-h-[calc(100vh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-[#dfe6f1] bg-white shadow-[0_28px_80px_rgba(15,23,42,0.28)] sm:max-h-[calc(100vh-4rem)] sm:rounded-[30px] dark:border-[#272e39] dark:bg-[#07090d] dark:shadow-[0_28px_80px_rgba(2,6,23,0.65)]">
				<button type="button" class="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-full text-[#5f6368] transition hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10" :aria-label="t('common.close')" @click="closeModal">
					<IconX :size="20" :stroke="2" />
				</button>

				<div class="border-b border-[#eef2f7] p-6 pr-16 dark:border-slate-800">
					<h3 class="text-2xl font-semibold text-[#202124] dark:text-slate-100">{{ t('updates.title') }}</h3>
					<p class="mt-1 text-sm leading-6 text-[#5f6368] dark:text-slate-400">{{ t('updates.subtitle') }}</p>
				</div>

				<div class="space-y-5 overflow-y-auto p-5 sm:p-6 dark:bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.18),_transparent_58%)]">
					<div class="grid gap-3 sm:grid-cols-[1fr_auto]">
						<a href="https://github.com/xkbm/omnicloud" target="_blank" rel="noreferrer" class="group flex items-center gap-3 rounded-[24px] border border-[#e7edf6] bg-[#f8fafd] p-4 transition hover:-translate-y-0.5 hover:border-[#bfdbfe] hover:bg-white hover:shadow-[0_14px_28px_rgba(26,115,232,0.12)] dark:border-slate-800 dark:bg-[#141821]/70 dark:hover:border-blue-400/40 dark:hover:bg-[#1b2029]">
							<span class="grid size-12 place-items-center rounded-2xl bg-white text-[#202124] shadow-sm dark:bg-[#07090d] dark:text-slate-100">
								<IconBrandGithub :size="24" :stroke="2" />
							</span>
							<span class="min-w-0 flex-1">
								<span class="block text-sm font-semibold text-[#202124] dark:text-slate-100">xkbm/omnicloud</span>
								<span class="mt-1 block truncate text-xs text-[#5f6368] dark:text-slate-400">{{ t('updates.openRepository') }}</span>
							</span>
							<IconExternalLink :size="18" :stroke="2" class="text-[#5f6368] transition group-hover:text-[#1a73e8] dark:text-slate-400 dark:group-hover:text-blue-300" />
						</a>

						<div class="flex items-center justify-center gap-1 rounded-[24px] border border-amber-200 bg-amber-50 p-4 text-center text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-200 sm:min-w-40 sm:flex-col sm:items-center sm:justify-center">
							<div class="flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.18em]">
								<IconStarFilled :size="14" :stroke="2" />
								<span>{{ t('updates.stars') }}</span>
							</div>
							<div class="text-3xl font-semibold leading-none">{{ starsLabel }}</div>
						</div>
					</div>

					<div class="rounded-[26px] border border-[#e7edf6] bg-white p-4 dark:border-slate-800 dark:bg-[#141821]/60">
						<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<div>
								<h4 class="text-sm font-semibold text-[#202124] dark:text-slate-100">{{ t('updates.latestUpdates') }}</h4>
								<p class="mt-1 text-xs leading-5 text-[#5f6368] dark:text-slate-400">
									<span v-if="lastFetchedAt">{{ t('updates.lastFetched', { date: formatDate(lastFetchedAt) }) }}</span>
									<span v-else>{{ t('updates.latestFromGithub') }}</span>
								</p>
							</div>
							<button type="button" class="inline-flex items-center justify-center gap-2 rounded-full bg-[#1a73e8] px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(26,115,232,0.24)] transition hover:bg-[#1765cc] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[#3b82f6] dark:hover:bg-[#2563eb]" :disabled="isLoading" @click="loadUpdates({ force: true })">
								<IconLoader2 v-if="isLoading" :size="16" :stroke="2" class="animate-spin" />
								<IconRefresh v-else :size="16" :stroke="2" />
								<span>{{ t('common.refresh') }}</span>
							</button>
						</div>

						<div v-if="errorMessage" class="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-200">
							{{ errorMessage }}
						</div>

						<div v-else-if="isLoading && !commits.length" class="flex items-center justify-center gap-3 rounded-2xl border border-dashed border-[#dfe6f1] p-8 text-sm text-[#5f6368] dark:border-[#272e39] dark:text-slate-400">
							<IconLoader2 :size="20" :stroke="2" class="animate-spin" />
							<span>{{ t('updates.loading') }}</span>
						</div>

						<div v-else class="space-y-3">
							<a v-for="commit in commits" :key="commit.sha" :href="commit.url" target="_blank" rel="noreferrer" class="group flex gap-3 rounded-2xl border border-[#e7edf6] bg-[#f8fafd] p-3 transition hover:-translate-y-0.5 hover:border-[#bfdbfe] hover:bg-white hover:shadow-[0_14px_28px_rgba(26,115,232,0.1)] dark:border-[#272e39] dark:bg-[#07090d]/60 dark:hover:border-blue-400/40 dark:hover:bg-slate-900">
								<span class="mt-0.5 grid size-10 shrink-0 place-items-center rounded-2xl bg-white text-[#1a73e8] shadow-sm dark:bg-[#12161d] dark:text-blue-300">
									<IconGitCommit :size="20" :stroke="2" />
								</span>
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-semibold text-[#202124] group-hover:text-[#1a73e8] dark:text-slate-100 dark:group-hover:text-blue-300">{{ commit.message }}</span>
									<span class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#5f6368] dark:text-slate-400">
										<span>{{ commit.author }}</span>
										<span>•</span>
										<span>{{ formatDate(commit.date) }}</span>
										<span>•</span>
										<span class="font-mono">{{ shortSha(commit.sha) }}</span>
									</span>
								</span>
							</a>
						</div>
					</div>
				</div>
			</div>
		</div>
	</Transition>
</template>
