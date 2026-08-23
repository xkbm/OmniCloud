<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IconCheck, IconLoader2, IconSend, IconSparkles, IconUserFilled, IconX } from '@tabler/icons-vue';
import { useChatStore } from '../stores/chatStore';

const props = defineProps({
	open: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

const { t } = useI18n();
const chatStore = useChatStore();

const inputMessage = ref('');
const messagesContainerRef = ref(null);

const suggestions = computed(() => [
	t('ai.suggestion1'),
	t('ai.suggestion2'),
	t('ai.suggestion3'),
]);

const followUpSuggestions = computed(() => [
	t('ai.suggestion4'),
	t('ai.suggestion5'),
	t('ai.suggestion6'),
]);

const showFollowUpSuggestions = computed(() => (
	!chatStore.isStreaming
	&& chatStore.messages.some((message) => message.role === 'assistant' && !message.streaming)
));

const toolLabels = {
	list_files: 'ai.tool.listFiles',
	search_files: 'ai.tool.searchFiles',
	get_storage_summary: 'ai.tool.storageSummary',
	create_folder: 'ai.tool.createFolder',
	move_item: 'ai.tool.moveItem',
	rename_item: 'ai.tool.renameItem',
	delete_item: 'ai.tool.deleteItem',
};

function toolLabel(toolName) {
	const key = toolLabels[toolName];
	return key ? t(key) : toolName;
}

function closeModal() {
	emit('close');
}

function scrollToBottom() {
	nextTick(() => {
		const container = messagesContainerRef.value;
		if (container) container.scrollTop = container.scrollHeight;
	});
}

async function sendMessage() {
	const text = inputMessage.value;
	if (!text.trim() || chatStore.isStreaming) return;
	inputMessage.value = '';
	await chatStore.sendMessage(text);
	scrollToBottom();
}

async function useSuggestion(suggestion) {
	if (chatStore.isStreaming) return;
	await chatStore.sendMessage(suggestion);
	scrollToBottom();
}

watch(
	() => props.open,
	(open) => {
		if (open) {
			scrollToBottom();
		}
	},
);

watch(
	() => chatStore.messages.length,
	() => scrollToBottom(),
);
</script>

<template>
	<Transition enter-active-class="transition duration-200 ease-out" enter-from-class="opacity-0" enter-to-class="opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="opacity-100" leave-to-class="opacity-0">
		<div v-if="open" class="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/45 px-4 py-8 backdrop-blur-sm max-sm:items-end max-sm:p-0" @click.self="closeModal">
			<div class="relative flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-[#dfe6f1] bg-white shadow-[0_28px_80px_rgba(15,23,42,0.28)] sm:max-h-[calc(100vh-4rem)] sm:rounded-[30px] dark:border-[#272e39] dark:bg-[#07090d] dark:shadow-[0_28px_80px_rgba(2,6,23,0.65)] max-sm:h-[94dvh] max-sm:max-h-[94dvh] max-sm:rounded-b-none max-sm:rounded-t-[28px] max-sm:border-b-0">
				<button type="button" class="absolute right-4 top-4 z-10 grid size-10 place-items-center rounded-full text-[#5f6368] transition hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10" :aria-label="t('common.close')" @click="closeModal">
					<IconX :size="20" :stroke="2" />
				</button>

				<div class="border-b border-[#eef2f7] p-6 pr-16 dark:border-slate-800">
					<div class="flex items-center gap-4">
						<span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#1a73e8] to-[#7c3aed] text-white shadow-[0_10px_24px_rgba(124,58,237,0.35)] dark:shadow-[0_10px_24px_rgba(124,58,237,0.45)]">
							<IconSparkles :size="24" :stroke="2" />
						</span>
						<div>
							<h3 class="text-2xl font-semibold text-[#202124] dark:text-slate-100">{{ t('ai.title') }}</h3>
							<p class="mt-1 text-sm leading-6 text-[#5f6368] dark:text-slate-400">{{ t('ai.subtitle') }}</p>
						</div>
					</div>
				</div>

				<div class="flex min-h-0 flex-1 flex-col">
					<div ref="messagesContainerRef" class="custom-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto p-5 sm:p-6 dark:bg-[radial-gradient(circle_at_top,_rgba(124,58,237,0.12),_transparent_58%)]">
						<div v-if="!chatStore.messages.length" class="flex h-full flex-col items-center justify-center gap-5 py-10 text-center">
							<span class="grid size-16 place-items-center rounded-3xl bg-[#eef2f7] text-[#1a73e8] dark:bg-[#12161d] dark:text-blue-300">
								<IconSparkles :size="32" :stroke="2" />
							</span>
							<div>
								<p class="text-lg font-semibold text-[#202124] dark:text-slate-100">{{ t('ai.emptyTitle') }}</p>
								<p class="mx-auto mt-1 max-w-md text-sm leading-6 text-[#5f6368] dark:text-slate-400">{{ t('ai.emptyHint') }}</p>
							</div>
							<div class="flex flex-wrap items-center justify-center gap-2">
								<button v-for="suggestion in suggestions" :key="suggestion" type="button" class="rounded-full border border-[#dfe6f1] bg-[#f8fafd] px-4 py-2 text-sm text-[#202124] transition hover:-translate-y-0.5 hover:border-[#bfdbfe] hover:bg-white hover:shadow-[0_10px_20px_rgba(26,115,232,0.12)] dark:border-[#272e39] dark:bg-[#141821]/70 dark:text-slate-100 dark:hover:border-blue-400/40 dark:hover:bg-[#1b2029]" @click="useSuggestion(suggestion)">
									{{ suggestion }}
								</button>
							</div>
						</div>

						<template v-else>
							<div v-for="message in chatStore.messages" :key="message.id" class="flex gap-3" :class="message.role === 'user' ? 'justify-end' : 'justify-start'">
								<span v-if="message.role === 'assistant'" class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#1a73e8] to-[#7c3aed] text-white">
									<IconSparkles :size="18" :stroke="2" />
								</span>
								<div class="max-w-[85%]">
									<div class="rounded-3xl px-4 py-3 text-sm leading-6" :class="message.role === 'user' ? 'rounded-br-lg bg-gradient-to-r from-[#1a73e8] to-[#4f8ff7] text-white shadow-[0_10px_24px_rgba(26,115,232,0.22)]' : 'rounded-bl-lg border border-[#e7edf6] bg-[#f8fafd] text-[#202124] dark:border-slate-800 dark:bg-[#141821]/70 dark:text-slate-100'">
										<p v-if="message.content || !message.streaming" class="whitespace-pre-wrap break-words">{{ message.content || t('ai.emptyAnswer') }}</p>
										<div v-else-if="!message.toolName" class="flex items-center gap-1.5 py-0.5" aria-hidden="true">
											<span class="size-2 animate-bounce rounded-full bg-[#1a73e8] dark:bg-blue-300" style="animation-delay: 0ms;" />
											<span class="size-2 animate-bounce rounded-full bg-[#1a73e8] dark:bg-blue-300" style="animation-delay: 150ms;" />
											<span class="size-2 animate-bounce rounded-full bg-[#1a73e8] dark:bg-blue-300" style="animation-delay: 300ms;" />
										</div>
										<span v-if="message.streaming && message.content" class="inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-current opacity-70" />
									</div>
									<div v-if="message.toolLog && message.toolLog.some((entry) => entry.status === 'done')" class="mt-1.5 flex max-w-full flex-wrap gap-1.5">
										<template v-for="(entry, entryIndex) in message.toolLog" :key="`${entry.name}-${entryIndex}`">
											<span v-if="entry.status === 'done'" class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs" :class="entry.ok ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300'">
												<IconCheck v-if="entry.ok" :size="12" :stroke="2.2" />
												<IconX v-else :size="12" :stroke="2.2" />
												<span>{{ toolLabel(entry.name) }}</span>
											</span>
										</template>
									</div>
									<div v-if="message.streaming && message.toolName" class="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-[#eef2f7] px-3 py-1 text-xs text-[#5f6368] dark:bg-[#12161d] dark:text-slate-400">
										<IconLoader2 :size="12" :stroke="2" class="animate-spin" />
										<span>{{ t('ai.toolRunning', { tool: toolLabel(message.toolName) }) }}</span>
									</div>
								</div>
								<span v-if="message.role === 'user'" class="mt-0.5 grid size-9 shrink-0 place-items-center rounded-2xl bg-[#e8f0fe] text-[#1a73e8] dark:bg-blue-500/15 dark:text-blue-300">
									<IconUserFilled :size="18" :stroke="0" />
								</span>
							</div>
						</template>

						<div v-if="showFollowUpSuggestions" class="flex flex-wrap justify-center gap-2 pb-2 pt-1">
							<button v-for="suggestion in followUpSuggestions" :key="suggestion" type="button" class="rounded-full border border-[#dfe6f1] bg-[#f8fafd] px-4 py-2 text-sm text-[#202124] transition hover:-translate-y-0.5 hover:border-[#bfdbfe] hover:bg-white hover:shadow-[0_10px_20px_rgba(26,115,232,0.12)] dark:border-[#272e39] dark:bg-[#141821]/70 dark:text-slate-100 dark:hover:border-blue-400/40 dark:hover:bg-[#1b2029]" @click="useSuggestion(suggestion)">
								{{ suggestion }}
							</button>
						</div>
					</div>

					<div class="border-t border-[#eef2f7] p-4 dark:border-slate-800 sm:p-5">
						<div class="flex items-end gap-3 rounded-[24px] border border-[#dfe6f1] bg-[#f8fafd] p-2 pl-4 transition focus-within:border-[#bfdbfe] focus-within:bg-white focus-within:shadow-[0_10px_24px_rgba(26,115,232,0.1)] dark:border-[#272e39] dark:bg-[#141821]/70 dark:focus-within:border-blue-400/40 dark:focus-within:bg-slate-800">
							<input v-model="inputMessage" type="text" :placeholder="t('ai.placeholder')" class="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm text-[#202124] outline-none placeholder:text-[#5f6368] dark:text-slate-100 dark:placeholder:text-slate-400" @keydown.enter.prevent="sendMessage" />
							<button type="button" class="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-r from-[#1a73e8] to-[#4f8ff7] text-white shadow-[0_10px_24px_rgba(26,115,232,0.28)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50" :disabled="!inputMessage.trim() || chatStore.isStreaming" :aria-label="t('ai.send')" @click="sendMessage">
								<IconLoader2 v-if="chatStore.isStreaming" :size="20" :stroke="2" class="animate-spin" />
								<IconSend v-else :size="20" :stroke="2" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
	</Transition>
</template>