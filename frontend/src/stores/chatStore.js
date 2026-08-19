import { defineStore } from 'pinia';
import { ref } from 'vue';
import { aiApi } from '../services/api';

export const useChatStore = defineStore('chat', () => {
	const messages = ref([]);
	const isStreaming = ref(false);
	const error = ref('');
	const isHistoryLoaded = ref(false);

	async function loadHistory() {
		if (isHistoryLoaded.value) return;

		try {
			const { data } = await aiApi.history();
			messages.value = Array.isArray(data) ? data : [];
			isHistoryLoaded.value = true;
		} catch (err) {
			error.value = err.message || 'Failed to load history';
		}
	}

	async function sendMessage(text) {
		const content = String(text || '').trim();
		if (!content || isStreaming.value) return;

		const userMessage = { id: `local-${Date.now()}`, role: 'user', content, created_at: new Date().toISOString() };
		const assistantMessage = { id: `local-${Date.now() + 1}`, role: 'assistant', content: '', streaming: true, toolName: null };
		messages.value.push(userMessage, assistantMessage);

		isStreaming.value = true;
		error.value = '';

		try {
			await aiApi.chat(content, {
				onEvent(event) {
					if (event.type === 'text') {
						assistantMessage.content += event.delta;
					} else if (event.type === 'tool') {
						assistantMessage.toolName = event.status === 'running' ? event.name : null;
					} else if (event.type === 'error') {
						assistantMessage.content = event.message || assistantMessage.content;
					}
				},
			});
		} catch (err) {
			assistantMessage.content = err.message || 'Error';
		} finally {
			assistantMessage.streaming = false;
			assistantMessage.toolName = null;
			isStreaming.value = false;
			isHistoryLoaded.value = true;
		}
	}

	function reset() {
		messages.value = [];
		isHistoryLoaded.value = false;
		error.value = '';
	}

	return { messages, isStreaming, error, isHistoryLoaded, loadHistory, sendMessage, reset };
});