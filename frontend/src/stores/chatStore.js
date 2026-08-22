import { defineStore } from 'pinia';
import { ref } from 'vue';
import { aiApi } from '../services/api';

export const useChatStore = defineStore('chat', () => {
	const messages = ref([]);
	const isStreaming = ref(false);
	const error = ref('');

	async function sendMessage(text) {
		const content = String(text || '').trim();
		if (!content || isStreaming.value) return;

		const userMessage = { id: `local-${Date.now()}`, role: 'user', content, created_at: new Date().toISOString() };
		const assistantMessage = { id: `local-${Date.now() + 1}`, role: 'assistant', content: '', streaming: true, toolName: null, toolLog: [] };
		messages.value.push(userMessage, assistantMessage);
		const assistantIdx = messages.value.length - 1;

		isStreaming.value = true;
		error.value = '';

		try {
			await aiApi.chat(content, {
				onEvent(event) {
					const msg = messages.value[assistantIdx];
					if (!msg) return;
				if (event.type === 'text') {
					msg.content += event.delta;
				} else if (event.type === 'tool') {
					msg.toolName = event.status === 'running' ? event.name : null;
					// Backend emits 'running' twice per call (parser + executor); dedupe by name.
					if (event.status === 'running') {
						if (!msg.toolLog.some((entry) => entry.name === event.name && entry.status === 'running')) {
							msg.toolLog.push({ name: event.name, status: 'running' });
						}
					} else {
						const pending = [...msg.toolLog].reverse().find((entry) => entry.name === event.name && entry.status === 'running');
						if (pending) { pending.status = 'done'; pending.ok = Boolean(event.ok); }
					}
				} else if (event.type === 'error') {
						msg.content = event.message || msg.content;
					}
				},
			});
		} catch (err) {
			const msg = messages.value[assistantIdx];
			if (msg) msg.content = err.message || 'Error';
		} finally {
			const msg = messages.value[assistantIdx];
			if (msg) {
				msg.streaming = false;
				msg.toolName = null;
				for (const entry of msg.toolLog) { if (entry.status === 'running') { entry.status = 'done'; entry.ok = false; } }
				if (!msg.content) msg.content = 'No se pudo generar una respuesta.';
			}
			isStreaming.value = false;
		}
	}

	function reset() {
		messages.value = [];
		error.value = '';
	}

	return { messages, isStreaming, error, sendMessage, reset };
});